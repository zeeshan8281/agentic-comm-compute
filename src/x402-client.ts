import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { getWallet } from "./wallet.js";
import { isAllowlistedUrl } from "./config.js";
import type { Quote } from "./types.js";

// One paid-fetch instance per session; x402-fetch handles the 402 handshake
// (parse PAYMENT-REQUIRED → sign transferWithAuthorization via the viem
// account → resend with `X-PAYMENT` header → return the merchant response).
let paidFetch: typeof fetch | undefined;

const getPaidFetch = (): typeof fetch => {
  if (paidFetch) return paidFetch;
  const wallet = getWallet();
  paidFetch = wrapFetchWithPayment(fetch, wallet.account) as typeof fetch;
  return paidFetch;
};

const guardUrl = (url: string) => {
  if (!isAllowlistedUrl(url)) {
    throw new Error(`Merchant URL not in allowlist: ${url}`);
  }
};

// Probe a merchant for its quote without paying. We send the request and read
// the 402 challenge headers, but we do NOT use the paid wrapper here.
export const fetchQuote = async (
  url: string,
  merchantId: string,
  itemId: string,
): Promise<Quote> => {
  guardUrl(url);
  const res = await fetch(url, { method: "GET" });
  if (res.status !== 402) {
    throw new Error(`Expected 402 from ${url}, got ${res.status}`);
  }
  const challenge = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
  if (!challenge) {
    throw new Error(`Merchant ${url} returned 402 but no PAYMENT-REQUIRED header`);
  }
  const decoded = JSON.parse(Buffer.from(challenge, "base64").toString("utf8"));
  // x402 challenge shape can vary slightly across facilitator versions; we
  // pull the EVM accept entry rather than assuming the schema.
  const accept = Array.isArray(decoded.accepts) ? decoded.accepts[0] : decoded;
  return {
    merchantId,
    itemId,
    amountUsdc: String(accept.maxAmountRequired ?? accept.amount ?? accept.price),
    payee: accept.payTo ?? accept.payee,
    network: accept.network ?? accept.chain,
    asset: accept.asset ?? accept.token,
    resourceUrl: url,
    validUntil: Number(accept.validUntil ?? accept.exp ?? Date.now() + 60_000),
    raw: decoded,
  };
};

// Settle and retrieve in one shot. x402-fetch transparently signs, retries
// with X-PAYMENT, and returns the merchant's 200 response.
export const payAndRetrieve = async (
  url: string,
): Promise<{ response: Response; txHash: `0x${string}`; paymentHeader: string }> => {
  guardUrl(url);
  const f = getPaidFetch();
  const response = await f(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Merchant returned ${response.status} after payment`);
  }
  const xpr = response.headers.get("x-payment-response");
  if (!xpr) {
    throw new Error("Merchant returned 200 but no X-PAYMENT-RESPONSE header");
  }
  const decoded = decodeXPaymentResponse(xpr) as { txHash?: string; transaction?: string };
  const txHash = (decoded.txHash ?? decoded.transaction ?? "0x") as `0x${string}`;
  return { response, txHash, paymentHeader: xpr };
};
