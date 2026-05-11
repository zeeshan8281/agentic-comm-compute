import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { env, catalog, merchants, findMerchantByItem, findCatalogItem } from "./config.js";
import { fetchQuote, payAndRetrieve } from "./x402-client.js";
import { assertWithinCaps, recordSpend, requiresHitl } from "./caps.js";
import { requestApproval } from "./hitl.js";
import { readAttestation } from "./attestation.js";
import { saveReceipt } from "./receipts.js";
import { getSession } from "./events.js";
import type { Quote, Receipt } from "./types.js";

export type RunInput = {
  sessionId?: string;
  item: string;
  maxUsdc: number;
};

const systemPrompt = `You are a purchase agent running inside an EigenCompute TEE.
You receive a single purchase request — an item id from the fixed catalog and a max USDC the user is willing to spend.
You must:
  1. Call discover_offers to find an allowlisted merchant for the item.
  2. Call fetch_quote to get the current price.
  3. If the quote is above the user's max, abort.
  4. Call pay_x402 — this will block on human approval when above the HITL threshold.
  5. The pay_x402 tool also retrieves the asset; you do not need a separate retrieve step.
  6. Call verify_delivery on the result.
  7. Stop. The orchestrator emits the receipt; you do not write it yourself.

Do not invent item ids. Do not call any URL not returned by discover_offers.`;

export const runAgent = async (input: RunInput): Promise<Receipt> => {
  const sessionId = input.sessionId ?? randomUUID();
  const session = getSession(sessionId);
  const startedAt = new Date().toISOString();
  session.emitEvent({
    kind: "request_received",
    message: `Purchase request: ${input.item} (max ${input.maxUsdc} USDC)`,
    data: { sessionId, ...input },
  });

  // The tools close over sessionId so each emits into the same SSE stream.
  // The agent's job is choosing *which* tools and *in what order* — the
  // dangerous primitives (signing, broadcasting) stay outside the model.
  let lastQuote: Quote | undefined;
  let lastPayment: { txHash: `0x${string}`; bytes: Buffer; contentType: string } | undefined;

  const tools = {
    discover_offers: tool({
      description:
        "Return allowlisted merchants whose catalog includes the requested item. Always call this first.",
      inputSchema: z.object({
        itemId: z.string().describe("Catalog id, e.g. 'merch-tshirt'"),
      }),
      execute: async ({ itemId }) => {
        session.emitEvent({
          kind: "discover_offers",
          message: `Discovering merchants for ${itemId}`,
        });
        const item = findCatalogItem(itemId);
        if (!item) {
          return { error: `Unknown item ${itemId}. Catalog: ${catalog.map((c) => c.id).join(", ")}` };
        }
        const matching = merchants
          .filter((m) => m.catalogItems.includes(itemId))
          .map((m) => ({ merchantId: m.id, name: m.name, resourceUrl: `${m.baseUrl}/${itemId}` }));
        return { item, merchants: matching };
      },
    }),

    fetch_quote: tool({
      description:
        "Hit the merchant resource URL and parse the 402 challenge. Returns price in USDC and payment terms.",
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
        try {
          const quote = await fetchQuote(resourceUrl, merchantId, itemId);
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
          const { response, txHash } = await payAndRetrieve(resourceUrl);
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
        "Validate the retrieved asset against the original quote. Checks content-type matches the catalog expectation and byteLength > 0. Returns sha256 of the bytes.",
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
  };

  const userPrompt = `Purchase request: { "item": "${input.item}", "maxUsdc": ${input.maxUsdc} }`;

  await generateText({
    model: env.AGENT_MODEL,
    system: systemPrompt,
    prompt: userPrompt,
    tools,
    stopWhen: stepCountIs(8),
  });

  if (!lastPayment || !lastQuote) {
    throw new Error("Agent finished without completing payment.");
  }

  const merchant = findMerchantByItem(input.item);
  const sha256 = createHash("sha256").update(lastPayment.bytes).digest("hex");
  const receipt: Receipt = {
    id: randomUUID(),
    request: { item: input.item, maxUsdc: String(input.maxUsdc) },
    merchantId: merchant?.id ?? lastQuote.merchantId,
    resourceUrl: lastQuote.resourceUrl,
    amountUsdc: lastQuote.amountUsdc,
    txHash: lastPayment.txHash,
    asset: {
      contentType: lastPayment.contentType,
      sha256,
      byteLength: lastPayment.bytes.byteLength,
    },
    attestation: readAttestation(),
    startedAt,
    completedAt: new Date().toISOString(),
  };
  saveReceipt(receipt);
  session.emitEvent({ kind: "receipt", message: "Receipt written", data: { receiptId: receipt.id } });
  return receipt;
};
