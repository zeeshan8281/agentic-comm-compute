export type CatalogItem = {
  id: string;
  description: string;
  expectedContentType?: string;
};

export type Merchant = {
  id: string;
  name: string;
  baseUrl: string;
  catalogItems: string[];
};

export type Quote = {
  merchantId: string;
  itemId: string;
  amountUsdc: string;
  payee: `0x${string}`;
  network: string;
  asset: `0x${string}`;
  resourceUrl: string;
  validUntil: number;
  raw: unknown;
};

export type PaymentResult = {
  txHash: `0x${string}`;
  paymentHeader: string;
  amountUsdc: string;
  settledAt: string;
};

export type Asset = {
  contentType: string;
  bytesBase64: string;
  sha256: string;
  byteLength: number;
};

export type Receipt = {
  id: string;
  request: { item: string; maxUsdc: string };
  merchantId: string;
  resourceUrl: string;
  amountUsdc: string;
  txHash: `0x${string}`;
  asset: { contentType: string; sha256: string; byteLength: number };
  attestation: AttestationSnapshot;
  startedAt: string;
  completedAt: string;
};

export type AttestationSnapshot = {
  gitSha: string;
  buildTime: string;
  appId: string;
  attestationHash: string;
  source: "tee" | "local-dev";
};

export type TimelineEvent = {
  ts: string;
  kind:
    | "request_received"
    | "discover_offers"
    | "fetch_quote"
    | "quote_received"
    | "hitl_requested"
    | "hitl_resolved"
    | "pay_x402"
    | "payment_settled"
    | "retrieve_asset"
    | "asset_received"
    | "verify_delivery"
    | "receipt"
    | "error";
  message: string;
  data?: Record<string, unknown>;
};
