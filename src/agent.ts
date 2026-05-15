import { generateText, tool, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import {
  env,
  catalog,
  merchants,
  findMerchantByItem,
  findCatalogItem,
  findResource,
  ryeBuyer,
} from "./config.js";
import { fetchQuote, payAndRetrieve } from "./x402-client.js";
import {
  listBrands as crListBrands,
  listProducts as crListProducts,
  pollUntilSettled as crPollUntilSettled,
  ordersUrl as crOrdersUrl,
  type CrOrderResponse,
} from "./cryptorefills.js";
import {
  createIntentUrl as ryeCreateIntentUrl,
  confirmIntentUrl as ryeConfirmIntentUrl,
  buildCreateIntentBody as ryeBuildCreateIntentBody,
  buildConfirmBody as ryeBuildConfirmBody,
  pollIntent as ryePollIntent,
  ryeTotalUsdc,
  type RyeIntent,
} from "./rye.js";
import {
  authUrl as lasoAuthUrl,
  orderGiftCardUrl as lasoOrderGiftCardUrl,
  searchGiftCards as lasoSearchGiftCards,
  lasoIdToken,
  type LasoAuthResponse,
  type LasoGiftOrder,
} from "./laso.js";
import { getWallet } from "./wallet.js";
import { assertWithinCaps, recordSpend, requiresHitl } from "./caps.js";
import { requestApproval } from "./hitl.js";
import { readAttestation } from "./attestation.js";
import { saveReceipt } from "./receipts.js";
import { getSession } from "./events.js";
import type { Quote, Receipt, VoucherDelivery } from "./types.js";

export type RunInput = {
  sessionId?: string;
  item: string;
  maxUsdc: number;
  // Optional per-call overrides. The Telegram bot passes the chat owner's
  // phone + email here so a single agent instance can serve many users
  // without leaking PII through the model. When unset, the tool falls back
  // to the global env values (single-tenant local dev). `country` drives
  // commerce-merchant routing: 'us' opens Rye + Laso paths; everywhere else
  // routes to Cryptorefills.
  userConfig?: {
    cryptorefillsEmail?: string;
    cryptorefillsBeneficiary?: string;
    cryptorefillsCountry?: string;
    country?: string;
  };
};

const systemPrompt = `You are a purchase agent running inside an EigenCompute TEE.
You receive a single purchase request and a max USDC the user is willing to spend.

Routing — pick exactly one path based on the user's country and the request:

PATH A — Static catalog (any country; the request matches a known item id like 'btc-fees-now', 'stablemerch-shirt', 'x-user-lookup', 'reddit-subreddit'):
  1. discover_offers(itemId) — locate the merchant + resource URL.
  2. fetch_quote(...) — read the live 402 challenge.
  3. If quote ≤ max, call pay_x402(...). Above the HITL threshold it blocks for human approval.
  4. verify_delivery(itemId). Stop.

PATH B — Cryptorefills (DEFAULT for all non-US countries; also for US gift cards / mobile recharges / eSIMs — '$25 Amazon gift card', '£20 Tesco voucher', '₹100 Swiggy', 'Airtel ₹50', 'DoorDash $10', 'eSIM 5GB'):
  1. cryptorefills_browse({country}) — list available brands. Skip if the request already names a specific brand + denomination AND you've already seen it this turn. Pass an explicit country only if the request unambiguously names a brand from a country different from the user's default (e.g. 'Tesco' → gb, 'DoorDash' → us, 'Jio' → in). Otherwise omit.
  2. cryptorefills_lookup_brand({country, brand_name}) — get the product_id + USDC price.
  3. If price_usdc ≤ max, call cryptorefills_buy({product_id, brandName, denomination, expectedUsdc, productValue?}).
  4. Stop.

PATH C — Rye (US ONLY; physical goods from any merchant URL — Shopify, Walmart, Best Buy, etc. Amazon listings are gated by Rye and will fail). Only choose this when the user is in US AND the request includes a product URL OR names a physical product to be shipped:
  1. rye_buy({productUrl, quantity}) — creates the checkout intent, polls for the offer, then confirms the order. The tool injects the buyer's shipping block from sealed env config. Above the HITL threshold it blocks for human approval. Returns the order id and tracking info.
  2. Stop.

PATH D — Laso (US ONLY; prepaid Visa cards, gift cards, push-to-debit). Only choose this when the user is in US AND the request is for a fiat instrument (prepaid card to spend anywhere, or a brand gift card you couldn't find on Cryptorefills):
  1. laso_search_giftcards({q}) — find the laso_server_id for the requested brand.
  2. laso_buy_giftcard({lasoServerId, amount, brandName}) — pays via x402 and returns the redemption code / URL. Above the HITL threshold it blocks for human approval.
  3. Stop.

US routing tie-breakers (when user.country='us'):
- "buy me <physical product>" or a Shopify/Walmart/Best Buy URL → Rye (PATH C).
- "$X prepaid Visa" or "load a Visa with $X" → Laso (PATH D).
- "$X <brand> gift card" → prefer Cryptorefills (PATH B), fall back to Laso (PATH D) if Cryptorefills doesn't carry it.
- Mobile top-ups → Cryptorefills (PATH B).

Country hints (when the user mentions a brand without a country):
- India (in): Jio, Airtel India, Vi, BSNL, Swiggy, Zomato, BookMyShow, Phonepe, Nykaa, MakeMyTrip, Amazon Pay India.
- United States (us): Amazon.com, Walmart, Target, Best Buy, DoorDash, Uber, Steam, Nintendo, Roblox, Netflix, Domino's, Starbucks.
- United Kingdom (gb): Amazon.co.uk, Tesco, Asda, Sainsbury's, John Lewis, M&S, Costa, Pret, Just Eat, Asos, Currys.
- Nigeria (ng): Jumia (NG), MTN Nigeria, Airtel Nigeria, Glo Mobile, 9mobile, T2 Mobile.
- South Africa (za): Amazon.co.za, Vodacom, MTN (SA), Telkom, CellC, PlayStation Store ZA, Steam ZA, Xbox ZA.
- Egypt (eg): Amazon.eg, Jumia Egypt, B-Tech, Shukran, IKEA Egypt, Vodafone Egypt, Orange Egypt, Etisalat.
- Global (any country): eSIM.

Hard rules:
- Never invent product_ids, item_ids, or laso_server_ids — only use ones returned by a discovery tool.
- Never call a URL outside the allowlist (the discovery tools enforce this).
- Do not retry the same purchase twice without changing inputs.
- Buy tools read the user's email, phone, and shipping address from sealed env config — never put PII in tool arguments and never ask the user for it.
- Rye and Laso are US-only. If the user's country is not 'us', do NOT call rye_* or laso_* tools.`;

export const runAgent = async (input: RunInput): Promise<Receipt> => {
  const sessionId = input.sessionId ?? randomUUID();
  const session = getSession(sessionId);
  const startedAt = new Date().toISOString();
  session.emitEvent({
    kind: "request_received",
    message: `Purchase request: ${input.item} (max ${input.maxUsdc} USDC)`,
    data: { sessionId, ...input },
  });

  // Tools close over sessionId so each emits into the same SSE stream.
  // The agent chooses *which* tools and *in what order* — the dangerous
  // primitives (signing, broadcasting) stay outside the model.
  let lastQuote: Quote | undefined;
  let lastPayment: { txHash: `0x${string}`; bytes: Buffer; contentType: string } | undefined;
  // Set by cryptorefills_buy so the orchestrator can attach voucher data
  // (code/pin/instructions) to the final Receipt. lastPayment is also set on
  // that path with the order JSON serialized as the asset bytes.
  let lastVoucher: VoucherDelivery | undefined;
  let lastCryptoOrder: { merchantId: "cryptorefills"; resourceUrl: string; amountUsdc: string } | undefined;
  // Cached Laso id_token for the duration of this agent run. /auth costs
  // $0.001 USDC each time; cache so a single session pays once.
  let lasoToken: string | undefined;

  const tools = {
    discover_offers: tool({
      description:
        "Return the allowlisted merchant + resource that sells the requested item. Always call this first. Returns the resource URL, HTTP method, and the merchant's identifier.",
      inputSchema: z.object({
        itemId: z.string().describe("Catalog id, e.g. 'stablemerch-shirt' or 'btc-fees-now'"),
      }),
      execute: async ({ itemId }) => {
        session.emitEvent({
          kind: "discover_offers",
          message: `Discovering merchants for ${itemId}`,
        });
        const item = findCatalogItem(itemId);
        const resource = findResource(itemId);
        const merchant = findMerchantByItem(itemId);
        if (!item || !resource || !merchant) {
          return {
            error: `Unknown item ${itemId}. Catalog: ${catalog.map((c) => c.id).join(", ")}`,
          };
        }
        return {
          item,
          offer: {
            merchantId: merchant.id,
            merchantName: merchant.name,
            resourceUrl: resource.url,
            method: resource.method,
            approxAmountUsdc: resource.approxAmountUsdc,
          },
        };
      },
    }),

    fetch_quote: tool({
      description:
        "Send the merchant the request and read the 402 challenge — does NOT pay. Returns the on-chain price in USDC and payment terms.",
      inputSchema: z.object({
        merchantId: z.string(),
        itemId: z.string(),
        resourceUrl: z.string().url(),
      }),
      execute: async ({ merchantId, itemId, resourceUrl }) => {
        session.emitEvent({
          kind: "fetch_quote",
          message: `Fetching quote from ${merchantId}`,
          data: { resourceUrl },
        });
        const resource = findResource(itemId);
        if (!resource || resource.url !== resourceUrl) {
          return { error: `Unknown resource ${itemId} ${resourceUrl}` };
        }
        try {
          const body = resource.buildBody?.();
          const quote = await fetchQuote({
            url: resource.url,
            method: resource.method,
            body,
            merchantId,
            itemId,
          });
          lastQuote = quote;
          session.emitEvent({
            kind: "quote_received",
            message: `Quote: ${quote.amountUsdc} USDC on ${quote.network}`,
            data: { amountUsdc: quote.amountUsdc, payee: quote.payee, network: quote.network },
          });
          return {
            amountUsdc: quote.amountUsdc,
            payee: quote.payee,
            network: quote.network,
            resourceUrl: quote.resourceUrl,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: `fetch_quote failed: ${msg}` });
          return { error: msg };
        }
      },
    }),

    pay_x402: tool({
      description:
        "Pay the merchant via x402 and retrieve the asset in one call. Blocks for human approval above the HITL threshold. Requires a prior successful fetch_quote.",
      inputSchema: z.object({
        merchantId: z.string(),
        itemId: z.string(),
        resourceUrl: z.string().url(),
        amountUsdc: z.string().describe("Must match the last fetched quote exactly"),
      }),
      execute: async ({ merchantId, itemId, resourceUrl, amountUsdc }) => {
        if (!lastQuote || lastQuote.resourceUrl !== resourceUrl) {
          return { error: "No matching quote on file. Call fetch_quote first." };
        }
        if (lastQuote.amountUsdc !== amountUsdc) {
          return { error: `Amount mismatch: quote=${lastQuote.amountUsdc} attempted=${amountUsdc}` };
        }
        const resource = findResource(itemId);
        if (!resource || resource.url !== resourceUrl) {
          return { error: `Resource lookup failed for ${itemId}` };
        }
        const amountNum = Number(amountUsdc);
        try {
          assertWithinCaps(sessionId, amountNum, input.maxUsdc);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: msg });
          return { error: msg };
        }

        if (requiresHitl(amountNum)) {
          session.emitEvent({
            kind: "hitl_requested",
            message: `Awaiting human approval for ${amountUsdc} USDC`,
            data: { amountUsdc, merchantId, itemId },
          });
          const approved = await requestApproval(sessionId, { amountUsdc, merchantId, itemId });
          session.emitEvent({
            kind: "hitl_resolved",
            message: approved ? "Approved" : "Rejected by user",
          });
          if (!approved) return { error: "Rejected by user" };
        }

        session.emitEvent({
          kind: "pay_x402",
          message: `Paying ${amountUsdc} USDC to ${merchantId}`,
        });

        try {
          const body = resource.buildBody?.();
          const { response, txHash } = await payAndRetrieve({
            url: resource.url,
            method: resource.method,
            body,
          });
          const contentType = response.headers.get("content-type") ?? "application/octet-stream";
          const bytes = Buffer.from(await response.arrayBuffer());
          lastPayment = { txHash, bytes, contentType };
          recordSpend(sessionId, amountNum);
          session.emitEvent({
            kind: "payment_settled",
            message: `Settled. tx ${txHash}`,
            data: { txHash, amountUsdc },
          });
          session.emitEvent({
            kind: "asset_received",
            message: `Asset received (${bytes.byteLength} bytes, ${contentType})`,
          });
          return { txHash, byteLength: bytes.byteLength, contentType };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: `pay_x402 failed: ${msg}` });
          return { error: msg };
        }
      },
    }),

    verify_delivery: tool({
      description:
        "Validate the retrieved asset against the catalog expectation. Checks content-type and byteLength > 0. Returns sha256 of the bytes.",
      inputSchema: z.object({
        itemId: z.string(),
      }),
      execute: async ({ itemId }) => {
        if (!lastPayment) return { error: "No paid asset to verify." };
        const item = findCatalogItem(itemId);
        const sha256 = createHash("sha256").update(lastPayment.bytes).digest("hex");
        const expectedCt = item?.expectedContentType;
        const okCt = !expectedCt || lastPayment.contentType.startsWith(expectedCt);
        const okBytes = lastPayment.bytes.byteLength > 0;
        session.emitEvent({
          kind: "verify_delivery",
          message: okCt && okBytes ? "Delivery verified" : "Delivery verification failed",
          data: { sha256, contentType: lastPayment.contentType },
        });
        return {
          ok: okCt && okBytes,
          sha256,
          contentType: lastPayment.contentType,
          byteLength: lastPayment.bytes.byteLength,
        };
      },
    }),

    cryptorefills_browse: tool({
      description:
        "List Cryptorefills brands available in a country (gift cards, mobile top-ups, vouchers). Country defaults to the user's configured country (currently '" +
        (input.userConfig?.cryptorefillsCountry ?? env.CRYPTOREFILLS_COUNTRY) +
        "'). Supported: 'in' (India, 142 brands), 'us' (United States, 854 brands), 'gb' (United Kingdom, 421 brands), 'eg' (Egypt, 90 brands), 'za' (South Africa, 49 brands), 'ng' (Nigeria, 39 brands). Returns brand_name + category + min/max amounts. Use this when the request is for a brand voucher you don't have a product_id for yet.",
      inputSchema: z.object({
        country: z.string().length(2).optional().describe("ISO-3166 alpha-2, e.g. 'in', 'us', 'gb'. Defaults to user's configured country."),
        category: z.string().optional().describe("Optional filter, e.g. 'food', 'e-commerce', 'mobile_credits', 'streaming', 'games'."),
      }),
      execute: async ({ country, category }) => {
        const cc = (
          country ?? input.userConfig?.cryptorefillsCountry ?? env.CRYPTOREFILLS_COUNTRY
        ).toLowerCase();
        session.emitEvent({
          kind: "discover_offers",
          message: `Browsing Cryptorefills brands for country=${cc}${category ? ` category=${category}` : ""}`,
        });
        try {
          const brands = await crListBrands(cc);
          const filtered = category
            ? brands.filter((b) => b.category.toLowerCase() === category.toLowerCase())
            : brands;
          return {
            country: cc,
            count: filtered.length,
            brands: filtered.map((b) => ({
              brand_name: b.brand_name,
              category: b.category,
              min: b.min,
              max: b.max,
            })),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: `cryptorefills_browse failed: ${msg}` });
          return { error: msg };
        }
      },
    }),

    cryptorefills_lookup_brand: tool({
      description:
        "Get available denominations + product_ids for a Cryptorefills brand. Returns the exact product_id you'll pass to cryptorefills_buy plus the USDC price. is_range=true products require productValue at buy time.",
      inputSchema: z.object({
        country: z.string().length(2).optional(),
        brand_name: z.string().describe("Exact brand_name from cryptorefills_browse"),
      }),
      execute: async ({ country, brand_name }) => {
        const cc = (
          country ?? input.userConfig?.cryptorefillsCountry ?? env.CRYPTOREFILLS_COUNTRY
        ).toLowerCase();
        session.emitEvent({
          kind: "fetch_quote",
          message: `Looking up Cryptorefills products: ${brand_name} (${cc})`,
        });
        try {
          const products = await crListProducts(cc, brand_name);
          return {
            country: cc,
            brand: brand_name,
            count: products.length,
            products: products.map((p) => ({
              product_id: p.product_id,
              product_name: p.product_name,
              denomination: p.denomination_label,
              currency: p.currency,
              is_range: p.is_range,
              face_value_usd: p.face_value_usd,
              price_usdc: p.price_usdc,
            })),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: `cryptorefills_lookup_brand failed: ${msg}` });
          return { error: msg };
        }
      },
    }),

    cryptorefills_buy: tool({
      description:
        "Buy a Cryptorefills product: signs the USDC payment via x402, posts the order, and polls until the voucher is delivered. Above the HITL threshold it blocks for human approval. Reads the user's email + beneficiary account from sealed env config — do NOT pass them in arguments.",
      inputSchema: z.object({
        productId: z.string().uuid().describe("From cryptorefills_lookup_brand"),
        brandName: z.string().describe("For the receipt — must match the brand the product was listed under"),
        denomination: z.string().describe("For the receipt — e.g. '10 INR', '₹500'"),
        expectedUsdc: z.string().describe("price_usdc from the lookup. The tool aborts if the merchant quote differs."),
        productValue: z
          .number()
          .optional()
          .describe("Required when the product is_range=true; numeric face value in the product's currency."),
      }),
      execute: async ({ productId, brandName, denomination, expectedUsdc, productValue }) => {
        const email = input.userConfig?.cryptorefillsEmail ?? env.CRYPTOREFILLS_EMAIL;
        const beneficiary =
          input.userConfig?.cryptorefillsBeneficiary ?? env.CRYPTOREFILLS_BENEFICIARY;
        if (!email || !beneficiary) {
          const msg =
            "Cryptorefills delivery info missing. Set CRYPTOREFILLS_EMAIL and CRYPTOREFILLS_BENEFICIARY (or pass userConfig).";
          session.emitEvent({ kind: "error", message: msg });
          return { error: msg };
        }
        const amountNum = Number(expectedUsdc);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
          return { error: `Invalid expectedUsdc: ${expectedUsdc}` };
        }
        try {
          assertWithinCaps(sessionId, amountNum, input.maxUsdc);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: msg });
          return { error: msg };
        }

        if (requiresHitl(amountNum)) {
          session.emitEvent({
            kind: "hitl_requested",
            message: `Awaiting human approval for ${expectedUsdc} USDC (${brandName} ${denomination})`,
            data: { amountUsdc: expectedUsdc, merchantId: "cryptorefills", itemId: productId },
          });
          const approved = await requestApproval(sessionId, {
            amountUsdc: expectedUsdc,
            merchantId: `cryptorefills (${brandName} ${denomination})`,
            itemId: productId,
          });
          session.emitEvent({
            kind: "hitl_resolved",
            message: approved ? "Approved" : "Rejected by user",
          });
          if (!approved) return { error: "Rejected by user" };
        }

        session.emitEvent({
          kind: "pay_x402",
          message: `Paying ${expectedUsdc} USDC for ${brandName} ${denomination}`,
        });

        const item: { product_id: string; beneficiary_account: string; product_value?: number } = {
          product_id: productId,
          beneficiary_account: beneficiary,
        };
        if (productValue !== undefined) item.product_value = productValue;

        try {
          const { response, txHash } = await payAndRetrieve({
            url: crOrdersUrl,
            method: "POST",
            body: { email, items: [item] },
          });
          const orderJson = (await response.json()) as CrOrderResponse;
          recordSpend(sessionId, amountNum);
          session.emitEvent({
            kind: "payment_settled",
            message: `Settled ${expectedUsdc} USDC. Order ${orderJson.order_id} status=${orderJson.status}. tx ${txHash}`,
            data: { txHash, amountUsdc: expectedUsdc, orderId: orderJson.order_id },
          });

          const final = await crPollUntilSettled(orderJson.order_id, {
            onTick: (r) =>
              session.emitEvent({
                kind: "retrieve_asset",
                message: `Order ${r.order_id} status=${r.status}`,
              }),
          });

          const delivery = final.deliveries?.[0];
          const voucher: VoucherDelivery = {
            brand: brandName,
            denomination,
            orderId: final.order_id,
            code: delivery?.voucher_code,
            pin: delivery?.voucher_pin,
            serial: delivery?.serial_number,
            expiry: delivery?.expiry_date,
            instructions: delivery?.redemption_instructions,
          };
          const bytes = Buffer.from(JSON.stringify(final), "utf8");
          lastPayment = { txHash, bytes, contentType: "application/json" };
          lastVoucher = voucher;
          lastCryptoOrder = {
            merchantId: "cryptorefills",
            resourceUrl: crOrdersUrl,
            amountUsdc: expectedUsdc,
          };
          session.emitEvent({
            kind: "asset_received",
            message:
              final.status === "completed"
                ? `Voucher delivered${voucher.code ? ` (code ${voucher.code.slice(0, 4)}…)` : ""}`
                : `Order ended in status=${final.status}`,
            data: { status: final.status, orderId: final.order_id },
          });

          if (final.status !== "completed") {
            return {
              error: `Order ${final.order_id} ended in status=${final.status}`,
              orderId: final.order_id,
              status: final.status,
            };
          }
          return {
            txHash,
            orderId: final.order_id,
            status: final.status,
            voucher: {
              brand: voucher.brand,
              denomination: voucher.denomination,
              code: voucher.code,
              pin: voucher.pin,
              instructions: voucher.instructions,
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: `cryptorefills_buy failed: ${msg}` });
          return { error: msg };
        }
      },
    }),

    rye_buy: tool({
      description:
        "Buy a physical product via Rye Universal Checkout (US shipping only). Pass the merchant product URL (Shopify, Walmart, etc — Amazon listings are gated). Tool creates a checkout intent, polls until the offer (price + shipping + tax) is ready, confirms the order, and polls until completed. Above HITL it blocks for approval. Buyer shipping info is injected from sealed env config — never pass PII as arguments.",
      inputSchema: z.object({
        productUrl: z.string().url().describe("Direct product URL on the merchant's site."),
        quantity: z.number().int().min(1).max(10).default(1),
      }),
      execute: async ({ productUrl, quantity }) => {
        const country = (input.userConfig?.country ?? "").toLowerCase();
        if (country && country !== "us") {
          return { error: `Rye ships US-only; user country is '${country}'.` };
        }
        let buyer;
        try {
          buyer = ryeBuyer();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: msg });
          return { error: msg };
        }
        const network =
          env.X402_NETWORK === "base-sepolia" ? "eip155:84532" : "eip155:8453";
        const wallet = getWallet();

        session.emitEvent({
          kind: "discover_offers",
          message: `Creating Rye checkout intent for ${productUrl}`,
        });
        try {
          const { response: intentRes, txHash: intentTx } = await payAndRetrieve({
            url: ryeCreateIntentUrl,
            method: "POST",
            body: ryeBuildCreateIntentBody({ productUrl, quantity, buyer, network }),
          });
          const intent = (await intentRes.json()) as RyeIntent;
          session.emitEvent({
            kind: "payment_settled",
            message: `Rye intent fee paid (${intent.id}). tx ${intentTx}`,
            data: { txHash: intentTx, intentId: intent.id },
          });

          const ready = await ryePollIntent(intent.id, wallet.address, {
            until: ["awaiting_confirmation", "failed"],
            onTick: (r) =>
              session.emitEvent({
                kind: "retrieve_asset",
                message: `Rye intent ${r.id} state=${r.state}`,
              }),
          });
          if (ready.state !== "awaiting_confirmation") {
            return { error: `Rye intent ${ready.id} ended in state=${ready.state}` };
          }

          const offerTotal = ryeTotalUsdc(ready);
          const offerCurrency = ready.offer?.cost?.total?.currencyCode ?? "USD";
          if (typeof offerTotal !== "number" || !Number.isFinite(offerTotal) || offerTotal <= 0) {
            return {
              error: `Rye offer has no usable total (cost=${JSON.stringify(ready.offer?.cost ?? null)})`,
            };
          }
          try {
            assertWithinCaps(sessionId, offerTotal, input.maxUsdc);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            session.emitEvent({ kind: "error", message: msg });
            return { error: msg };
          }
          if (requiresHitl(offerTotal)) {
            session.emitEvent({
              kind: "hitl_requested",
              message: `Awaiting human approval for Rye order ${offerTotal} ${offerCurrency}`,
              data: { amountUsdc: String(offerTotal), merchantId: "rye", itemId: ready.id },
            });
            const approved = await requestApproval(sessionId, {
              amountUsdc: String(offerTotal),
              merchantId: `rye (${productUrl})`,
              itemId: ready.id,
            });
            session.emitEvent({
              kind: "hitl_resolved",
              message: approved ? "Approved" : "Rejected by user",
            });
            if (!approved) return { error: "Rejected by user" };
          }

          session.emitEvent({
            kind: "pay_x402",
            message: `Confirming Rye order ${ready.id} (${offerTotal} ${offerCurrency})`,
          });
          const { response: confirmRes, txHash: confirmTx } = await payAndRetrieve({
            url: ryeConfirmIntentUrl,
            method: "POST",
            body: ryeBuildConfirmBody({ id: ready.id, network }),
          });
          await confirmRes.json().catch(() => undefined);
          recordSpend(sessionId, offerTotal);

          const final = await ryePollIntent(ready.id, wallet.address, {
            until: ["completed", "failed"],
            onTick: (r) =>
              session.emitEvent({
                kind: "retrieve_asset",
                message: `Rye order ${r.id} state=${r.state}`,
              }),
          });

          const bytes = Buffer.from(JSON.stringify(final), "utf8");
          lastPayment = { txHash: confirmTx, bytes, contentType: "application/json" };
          lastCryptoOrder = {
            merchantId: "rye" as unknown as "cryptorefills",
            resourceUrl: ryeConfirmIntentUrl,
            amountUsdc: String(offerTotal),
          };
          lastVoucher = {
            brand: "Rye",
            denomination: `${offerTotal} ${offerCurrency}`,
            orderId: final.orderId ?? final.id,
            instructions: `Shipped via Rye. Intent ${final.id}, state=${final.state}.`,
          };
          session.emitEvent({
            kind: "asset_received",
            message:
              final.state === "completed"
                ? `Rye order placed (orderId ${final.orderId ?? final.id})`
                : `Rye order ended in state=${final.state}`,
            data: { state: final.state, orderId: final.orderId ?? final.id },
          });

          if (final.state !== "completed") {
            return {
              error: `Rye order ended in state=${final.state}`,
              orderId: final.orderId ?? final.id,
              state: final.state,
            };
          }
          return {
            txHash: confirmTx,
            intentId: final.id,
            orderId: final.orderId ?? final.id,
            state: final.state,
            total: offerTotal,
            currency: offerCurrency,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: `rye_buy failed: ${msg}` });
          return { error: msg };
        }
      },
    }),

    laso_search_giftcards: tool({
      description:
        "Search Laso Finance's gift card catalog (US). Returns laso_server_id + denomination ranges. Authenticates via x402 ($0.001 USDC) and caches the token for the rest of the session. Pass a brand keyword in `q`.",
      inputSchema: z.object({
        q: z.string().optional().describe("Brand keyword, e.g. 'Amazon', 'Starbucks'."),
        country: z.string().length(2).optional().describe("ISO-3166 alpha-2; defaults to 'US'."),
      }),
      execute: async ({ q, country }) => {
        const userCountry = (input.userConfig?.country ?? "").toLowerCase();
        if (userCountry && userCountry !== "us") {
          return { error: `Laso is US-only; user country is '${userCountry}'.` };
        }
        try {
          if (!lasoToken) {
            session.emitEvent({
              kind: "discover_offers",
              message: "Authenticating with Laso ($0.001 USDC)",
            });
            const { response } = await payAndRetrieve({ url: lasoAuthUrl, method: "GET" });
            const auth = (await response.json()) as LasoAuthResponse;
            const token = lasoIdToken(auth);
            if (!token) {
              return { error: `Laso /auth returned no id_token (shape=${JSON.stringify(Object.keys(auth))})` };
            }
            lasoToken = token;
          }
          const cards = await lasoSearchGiftCards(lasoToken, { q, country: country ?? "US" });
          return {
            count: cards.length,
            cards: cards.slice(0, 25).map((c) => ({
              laso_server_id: c.laso_server_id,
              name: c.name,
              currency: c.currency,
              min: c.min,
              max: c.max,
              increment: c.increment,
              denominations: c.denominations,
            })),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: `laso_search_giftcards failed: ${msg}` });
          return { error: msg };
        }
      },
    }),

    laso_buy_giftcard: tool({
      description:
        "Buy a US gift card via Laso Finance. Pass the laso_server_id from laso_search_giftcards and the face-value amount in USD. Above HITL it blocks for human approval. Returns redemption_code / redemption_url.",
      inputSchema: z.object({
        lasoServerId: z.string().describe("From laso_search_giftcards."),
        amount: z.number().min(5).max(9000),
        brandName: z.string().describe("For the receipt — must match the card returned by search."),
        country: z.string().length(2).optional(),
      }),
      execute: async ({ lasoServerId, amount, brandName, country }) => {
        const userCountry = (input.userConfig?.country ?? "").toLowerCase();
        if (userCountry && userCountry !== "us") {
          return { error: `Laso is US-only; user country is '${userCountry}'.` };
        }
        try {
          assertWithinCaps(sessionId, amount, input.maxUsdc);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: msg });
          return { error: msg };
        }
        if (requiresHitl(amount)) {
          session.emitEvent({
            kind: "hitl_requested",
            message: `Awaiting human approval for ${amount} USDC (Laso ${brandName})`,
            data: { amountUsdc: String(amount), merchantId: "laso", itemId: lasoServerId },
          });
          const approved = await requestApproval(sessionId, {
            amountUsdc: String(amount),
            merchantId: `laso (${brandName})`,
            itemId: lasoServerId,
          });
          session.emitEvent({
            kind: "hitl_resolved",
            message: approved ? "Approved" : "Rejected by user",
          });
          if (!approved) return { error: "Rejected by user" };
        }
        session.emitEvent({
          kind: "pay_x402",
          message: `Paying ${amount} USDC for ${brandName} via Laso`,
        });
        try {
          const url = lasoOrderGiftCardUrl({ amount, lasoServerId, country: country ?? "US" });
          const { response, txHash } = await payAndRetrieve({ url, method: "GET" });
          const order = (await response.json()) as LasoGiftOrder;
          recordSpend(sessionId, amount);
          const bytes = Buffer.from(JSON.stringify(order), "utf8");
          lastPayment = { txHash, bytes, contentType: "application/json" };
          lastCryptoOrder = {
            merchantId: "laso" as unknown as "cryptorefills",
            resourceUrl: url,
            amountUsdc: String(amount),
          };
          lastVoucher = {
            brand: brandName,
            denomination: `${amount} ${order.currency ?? "USD"}`,
            orderId: order.card_id ?? lasoServerId,
            code: order.redemption_code,
            pin: order.redemption_pin,
            expiry: order.expires_at,
            instructions:
              order.instructions ??
              (order.redemption_url ? `Redeem at ${order.redemption_url}` : undefined),
          };
          session.emitEvent({
            kind: "asset_received",
            message: `Laso gift card delivered${order.redemption_code ? ` (code ${order.redemption_code.slice(0, 4)}…)` : ""}`,
            data: { cardId: order.card_id },
          });
          return {
            txHash,
            cardId: order.card_id,
            brand: brandName,
            amount,
            currency: order.currency ?? "USD",
            redemption_code: order.redemption_code,
            redemption_url: order.redemption_url,
            expires_at: order.expires_at,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          session.emitEvent({ kind: "error", message: `laso_buy_giftcard failed: ${msg}` });
          return { error: msg };
        }
      },
    }),
  };

  const userPrompt = `Purchase request: { "item": "${input.item}", "maxUsdc": ${input.maxUsdc} }`;

  // Direct Anthropic when ANTHROPIC_API_KEY is set; fall through to the AI
  // SDK gateway-style provider string when only AI_GATEWAY_API_KEY is set.
  const model = env.ANTHROPIC_API_KEY ? anthropic(env.AGENT_MODEL) : env.AGENT_MODEL;
  await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    tools,
    // Cryptorefills can take a few extra steps (browse + lookup + buy).
    stopWhen: stepCountIs(12),
  });

  if (!lastPayment || (!lastQuote && !lastCryptoOrder)) {
    throw new Error("Agent finished without completing payment.");
  }

  const merchant = findMerchantByItem(input.item);
  const sha256 = createHash("sha256").update(lastPayment.bytes).digest("hex");
  const receiptMerchantId = lastCryptoOrder?.merchantId ?? merchant?.id ?? lastQuote!.merchantId;
  const receiptResourceUrl = lastCryptoOrder?.resourceUrl ?? lastQuote!.resourceUrl;
  const receiptAmountUsdc = lastCryptoOrder?.amountUsdc ?? lastQuote!.amountUsdc;
  const receipt: Receipt = {
    id: randomUUID(),
    request: { item: input.item, maxUsdc: String(input.maxUsdc) },
    merchantId: receiptMerchantId,
    resourceUrl: receiptResourceUrl,
    amountUsdc: receiptAmountUsdc,
    txHash: lastPayment.txHash,
    asset: {
      contentType: lastPayment.contentType,
      sha256,
      byteLength: lastPayment.bytes.byteLength,
    },
    voucher: lastVoucher,
    attestation: readAttestation(),
    startedAt,
    completedAt: new Date().toISOString(),
  };
  saveReceipt(receipt);
  session.emitEvent({ kind: "receipt", message: "Receipt written", data: { receiptId: receipt.id } });
  return receipt;
};
