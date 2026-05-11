import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { getWallet } from "./wallet.js";
import { isAllowlistedUrl } from "./config.js";
import type { Quote } from "./types.js";

// One paid-fetch instance per process; x402-fetch handles the 402 handshake
// (parse PAYMENT-REQUIRED → sign transferWithAuthorization via the viem
// account → resend with `X-PAYMENT` header → return the merchant response).
//
// maxValue is the per-request hard cap enforced inside x402-fetch. We set it
// to 25 USDC (in 6-decimal base units) so StableMerch's $20 shirts go through
// while still bounding the worst case.
const MAX_PAYMENT_BASE_UNITS = 25_000_000n; // 25 USDC

let paidFetch: typeof fetch | undefined;

const getPaidFetch = (): typeof fetch => {
  if (paidFetch) return paidFetch;
  const wallet = getWallet();
  paidFetch = wrapFetchWithPayment(
    fetch,
    wallet.account,
    MAX_PAYMENT_BASE_UNITS,
  ) as typeof fetch;
  return paidFetch;
};

const guardUrl = (url: string) => {
  if (!isAllowlistedUrl(url)) {
    throw new Error(`Merchant URL not in allowlist: ${url}`);
  }
};

const headersFor = (method: string, hasBody: boolean): Record<string, string> => {
  const h: Record<string, string> = { accept: "application/json" };
  if (method === "POST" && hasBody) h["content-type"] = "application/json";
  return h;
};

export type ProbeOptions = {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  merchantId: string;
  itemId: string;
};

// Probe a merchant for its quote without paying. Send the request as-is and
// read the 402 challenge headers; do NOT use the paid wrapper here.
export const fetchQuote = async (opts: ProbeOptions): Promise<Quote> => {
  guardUrl(opts.url);
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const res = await fetch(opts.url, {
    method: opts.method,
    headers: headersFor(opts.method, Boolean(body)),
    body,
  });
  if (res.status !== 402) {
    throw new Error(`Expected 402 from ${opts.url}, got ${res.status}`);
  }
  const challenge = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
  if (!challenge) {
    throw new Error(`Merchant ${opts.url} returned 402 but no PAYMENT-REQUIRED header`);
  }
  const decoded = JSON.parse(Buffer.from(challenge, "base64").toString("utf8"));
  // x402 challenge shape can vary slightly across facilitator versions.
  // Prefer the EVM accept entry over alternates like Solana / Tempo.
  const accepts = Array.isArray(decoded.accepts) ? decoded.accepts : [decoded];
  const evm =
    accepts.find((a: { network?: string }) => a.network?.startsWith("eip155:")) ?? accepts[0];
  // x402 prices are in base units (6 decimals for USDC). Surface the human
  // form so the tool layer and the cap check share one currency.
  const baseUnits = String(evm.maxAmountRequired ?? evm.amount ?? evm.price ?? "0");
  const amountUsdc = baseUnitsToUsdc(baseUnits);
  return {
    merchantId: opts.merchantId,
    itemId: opts.itemId,
    amountUsdc,
    payee: evm.payTo ?? evm.payee,
    network: evm.network ?? evm.chain,
    asset: evm.asset ?? evm.token,
    resourceUrl: opts.url,
    validUntil: Number(evm.validUntil ?? evm.exp ?? Date.now() + 60_000),
    raw: decoded,
  };
};

export type PayOptions = {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
};

// Settle and retrieve in one shot. x402-fetch transparently signs, retries
// with X-PAYMENT, and returns the merchant's 200 response.
export const payAndRetrieve = async (
  opts: PayOptions,
): Promise<{ response: Response; txHash: `0x${string}`; paymentHeader: string }> => {
  guardUrl(opts.url);
  const f = getPaidFetch();
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const response = await f(opts.url, {
    method: opts.method,
    headers: headersFor(opts.method, Boolean(body)),
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Merchant returned ${response.status} after payment: ${text.slice(0, 200)}`);
  }
  const xpr = response.headers.get("x-payment-response");
  if (!xpr) {
    throw new Error("Merchant returned 200 but no X-PAYMENT-RESPONSE header");
  }
  const decoded = decodeXPaymentResponse(xpr) as { txHash?: string; transaction?: string };
  const txHash = (decoded.txHash ?? decoded.transaction ?? "0x") as `0x${string}`;
  return { response, txHash, paymentHeader: xpr };
};

const baseUnitsToUsdc = (baseUnits: string): string => {
  // USDC has 6 decimals on Base. Convert without lossy float math.
  const n = BigInt(baseUnits);
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
};
