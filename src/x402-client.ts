import { getAddress, toHex } from "viem";
import { randomBytes } from "node:crypto";
import { getWallet } from "./wallet.js";
import { isAllowlistedUrl } from "./config.js";
import type { Quote } from "./types.js";

// Hard upper bound on a single payment, in USDC base units (6 decimals).
// 1.5 USDC ≈ ₹125 — the testing-phase backstop. Sits just above the policy
// cap (CAP_PER_PAYMENT_USDC=1.20) so even if env caps are bypassed, the
// signer refuses anything materially above ₹100.
const MAX_PAYMENT_BASE_UNITS = 1_500_000n;

// Networks the agent will sign for. The CAIP-2 id is what the v2 wire format
// uses on the wire; the chainId is what EIP-712 needs in the domain.
const NETWORKS: Record<string, number> = {
  "eip155:8453": 8453,
  "eip155:84532": 84532,
};

type V2Accept = {
  scheme: string;
  network: string;
  amount?: string;
  maxAmountRequired?: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
  extra?: { name?: string; version?: string };
};

type V2Challenge = {
  x402Version: number;
  resource?: { url?: string; description?: string; mimeType?: string };
  accepts: V2Accept[];
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

// base64url decode (RFC 4648 §5) — Node's Buffer accepts "base64url" since
// v16. Falls back to base64 for older / non-url-safe encodings.
const decodeChallengeJson = (raw: string): string => {
  try {
    return Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return Buffer.from(raw, "base64").toString("utf8");
  }
};

// Read the merchant's 402 challenge from the `payment-required` response
// header. Body just carries human-readable error text we can ignore.
const readChallenge = (res: Response): V2Challenge => {
  const raw = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
  if (!raw) {
    throw new Error("Merchant returned 402 but no payment-required header");
  }
  const json = decodeChallengeJson(raw);
  const decoded = JSON.parse(json) as V2Challenge;
  if (!Array.isArray(decoded.accepts) || decoded.accepts.length === 0) {
    throw new Error("payment-required challenge has no `accepts` entries");
  }
  return decoded;
};

// Pick the first EVM accept entry whose CAIP-2 network we know how to sign for.
const selectEvmAccept = (challenge: V2Challenge): V2Accept => {
  const evm = challenge.accepts.find((a) => a.network in NETWORKS);
  if (!evm) {
    const seen = challenge.accepts.map((a) => a.network).join(", ");
    throw new Error(`No supported EVM accept in challenge. Saw: ${seen}`);
  }
  return evm;
};

const amountFromAccept = (a: V2Accept): string => {
  const v = a.maxAmountRequired ?? a.amount;
  if (!v) throw new Error("Accept entry has neither maxAmountRequired nor amount");
  return v;
};

// EIP-3009 TransferWithAuthorization (the EIP-712 type x402 settles via).
const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Sign and base64url-encode the v2 wire-format payment payload. The on-wire
// shape matches what every modern x402 facilitator (Coinbase CDP v2, AgentCash,
// Cryptorefills) verifies. Crucially: x402Version is 2 and the network field
// is the CAIP-2 id ("eip155:8453"), NOT the x402 npm lib's short name "base".
const signV2Payment = async (accept: V2Accept): Promise<string> => {
  const wallet = getWallet();
  const chainId = NETWORKS[accept.network];
  const value = amountFromAccept(accept);
  if (BigInt(value) > MAX_PAYMENT_BASE_UNITS) {
    throw new Error(`Quote ${value} base units exceeds per-payment cap`);
  }
  const timeout = accept.maxTimeoutSeconds ?? 300;
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address,
    to: getAddress(accept.payTo),
    value,
    validAfter: "0",
    validBefore: String(now + timeout),
    nonce: toHex(randomBytes(32)),
  };
  const signature = await wallet.account.signTypedData({
    domain: {
      name: accept.extra?.name ?? "USD Coin",
      version: accept.extra?.version ?? "2",
      chainId,
      verifyingContract: getAddress(accept.asset),
    },
    types: AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  });
  const envelope = {
    x402Version: 2,
    scheme: "exact",
    network: accept.network,
    accepted: accept,
    payload: { signature, authorization },
  };
  // Facilitator decoders are not consistent:
  //   - Satoshi's: strict Python b64decode, fails on "Incorrect padding"
  //     unless `=` padding is present.
  //   - Cryptorefills': strict base64url, fails on `+` / `/` chars.
  // The common subset is base64url WITH padding kept — RFC 4648 §5 explicitly
  // allows it and every decoder I've seen accepts it.
  return Buffer.from(JSON.stringify(envelope), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

export type ProbeOptions = {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  merchantId: string;
  itemId: string;
};

// Probe a merchant for its quote without paying. Send the request as-is and
// parse the 402 challenge from the payment-required header.
export const fetchQuote = async (opts: ProbeOptions): Promise<Quote> => {
  guardUrl(opts.url);
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const res = await fetch(opts.url, {
    method: opts.method,
    headers: headersFor(opts.method, Boolean(body)),
    body,
  });
  if (res.status !== 402) {
    const text = await res.text().catch(() => "");
    throw new Error(`Expected 402 from ${opts.url}, got ${res.status}: ${text.slice(0, 200)}`);
  }
  const challenge = readChallenge(res);
  const evm = selectEvmAccept(challenge);
  const baseUnits = amountFromAccept(evm);
  return {
    merchantId: opts.merchantId,
    itemId: opts.itemId,
    amountUsdc: baseUnitsToUsdc(baseUnits),
    payee: getAddress(evm.payTo) as `0x${string}`,
    network: evm.network,
    asset: getAddress(evm.asset) as `0x${string}`,
    resourceUrl: opts.url,
    validUntil: Date.now() + (evm.maxTimeoutSeconds ?? 300) * 1000,
    raw: challenge,
  };
};

export type PayOptions = {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
};

// Settle and retrieve in one shot. Probe → read header challenge → sign v2 →
// retry with PAYMENT-SIGNATURE + X-PAYMENT (legacy) → return the 200.
export const payAndRetrieve = async (
  opts: PayOptions,
): Promise<{ response: Response; txHash: `0x${string}`; paymentHeader: string }> => {
  guardUrl(opts.url);
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const baseHeaders = headersFor(opts.method, Boolean(body));

  const probe = await fetch(opts.url, { method: opts.method, headers: baseHeaders, body });
  if (probe.status !== 402) {
    const text = await probe.text().catch(() => "");
    throw new Error(`Expected 402 on probe, got ${probe.status}: ${text.slice(0, 200)}`);
  }
  await probe.text().catch(() => "");

  const challenge = readChallenge(probe);
  const evm = selectEvmAccept(challenge);
  const sessionId = probe.headers.get("x-session-id") ?? probe.headers.get("X-Session-Id");

  const paymentHeader = await signV2Payment(evm);

  // Send both the v2 header name and the legacy X-PAYMENT name. Every merchant
  // on the allowlist accepts at least one; sending both costs nothing.
  const retryHeaders: Record<string, string> = {
    ...baseHeaders,
    "PAYMENT-SIGNATURE": paymentHeader,
    "X-PAYMENT": paymentHeader,
  };
  if (sessionId) retryHeaders["X-Session-Id"] = sessionId;

  const response = await fetch(opts.url, {
    method: opts.method,
    headers: retryHeaders,
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Merchant returned ${response.status} after payment: ${text.slice(0, 400)}`);
  }

  const xpr =
    response.headers.get("payment-response") ??
    response.headers.get("x-payment-response");
  let txHash: `0x${string}` = "0x";
  if (xpr) {
    try {
      const json = decodeChallengeJson(xpr);
      const decoded = JSON.parse(json) as {
        txHash?: string;
        transaction?: string;
        transactionHash?: string;
      };
      txHash = (decoded.txHash ?? decoded.transactionHash ?? decoded.transaction ?? "0x") as `0x${string}`;
    } catch {
      // Some merchants emit a non-standard settlement payload; leave txHash
      // unset and let the caller flag it.
    }
  }
  return { response, txHash, paymentHeader };
};

const baseUnitsToUsdc = (baseUnits: string): string => {
  const n = BigInt(baseUnits);
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
};
