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
} from "./config.js";
import { fetchQuote, payAndRetrieve } from "./x402-client.js";
import {
  listBrands as crListBrands,
  listProducts as crListProducts,
  pollUntilSettled as crPollUntilSettled,
  ordersUrl as crOrdersUrl,
  type CrOrderResponse,
} from "./cryptorefills.js";
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
  // Optional per-call overrides for Cryptorefills delivery. The Telegram bot
  // passes the chat owner's phone + email here so a single agent instance can
  // serve many users without leaking PII through the model. When unset, the
  // tool falls back to the global env values (single-tenant local dev).
  userConfig?: {
    cryptorefillsEmail?: string;
    cryptorefillsBeneficiary?: string;
    cryptorefillsCountry?: string;
  };
};

const systemPrompt = `You are a purchase agent running inside an EigenCompute TEE.
You receive a single purchase request and a max USDC the user is willing to spend.

There are two purchase paths. Pick exactly one based on the request:

PATH A — Static catalog (the request matches a known item id like 'btc-fees-now', 'stablemerch-shirt', 'x-user-lookup', 'reddit-subreddit'):
  1. discover_offers(itemId) — locate the merchant + resource URL.
  2. fetch_quote(...) — read the live 402 challenge.
  3. If quote ≤ max, call pay_x402(...). Above the HITL threshold it blocks for human approval.
  4. verify_delivery(itemId). Stop.

PATH B — Cryptorefills (the request describes a gift card, mobile top-up, or country-scoped voucher — e.g. 'Google Play 10 INR', '₹100 Swiggy', 'Airtel ₹50 recharge', 'Phonepe wallet ₹500'):
  1. cryptorefills_browse({country}) — list available brands in the user's country to confirm the brand exists. Skip this if the request already names a specific brand and denomination AND you've already seen it this turn.
  2. cryptorefills_lookup_brand({country, brand_name}) — get the product_id for the requested denomination and its USDC price.
  3. If price_usdc ≤ max, call cryptorefills_buy({product_id, brandName, denomination, expectedUsdc, productValue?}). Above the HITL threshold it blocks for human approval. The buy tool pays, polls the order, and returns the voucher code.
  4. Stop.

Hard rules:
- Never invent product_ids or item_ids — only use ones returned by a discovery tool.
- Never call a URL outside the allowlist (the discovery tools enforce this).
- Do not retry the same purchase twice without changing inputs.
- The buy tool reads the user's email and beneficiary account from a sealed env config — never put those in tool arguments and never ask the user for them.`;

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
        "List Cryptorefills brands available in a country (gift cards, mobile top-ups, vouchers). Country code defaults to the user's configured country (env CRYPTOREFILLS_COUNTRY, currently '" +
        env.CRYPTOREFILLS_COUNTRY +
        "'). Returns brand_name + category + min/max amounts. Use this when the request is for a brand voucher you don't have a product_id for yet.",
      inputSchema: z.object({
        country: z.string().length(2).optional().describe("ISO-3166 alpha-2, e.g. 'in', 'us'. Defaults to env."),
        category: z.string().optional().describe("Optional filter, e.g. 'food', 'e-commerce', 'mobile_credits'."),
      }),
      execute: async ({ country, category }) => {
        const cc = (country ?? env.CRYPTOREFILLS_COUNTRY).toLowerCase();
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
        const cc = (country ?? env.CRYPTOREFILLS_COUNTRY).toLowerCase();
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
