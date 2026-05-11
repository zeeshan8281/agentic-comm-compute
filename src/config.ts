import "dotenv/config";

const optional = (k: string, fallback = ""): string => process.env[k] ?? fallback;

export const env = {
  SERVICE_NAME: optional("SERVICE_NAME", "agentic-commerce-compte"),
  PORT: Number(optional("PORT", "8080")),
  LOG_LEVEL: optional("LOG_LEVEL", "info"),

  AI_GATEWAY_API_KEY: optional("AI_GATEWAY_API_KEY"),
  AGENT_MODEL: optional("AGENT_MODEL", "anthropic/claude-sonnet-4.6"),

  AGENT_PRIVATE_KEY: optional("AGENT_PRIVATE_KEY"),
  AGENT_WALLET_ADDRESS: optional("AGENT_WALLET_ADDRESS"),

  X402_NETWORK: optional("X402_NETWORK", "base"),
  BASE_RPC_URL: optional("BASE_RPC_URL", "https://mainnet.base.org"),

  CAP_PER_PAYMENT_USDC: Number(optional("CAP_PER_PAYMENT_USDC", "1")),
  CAP_PER_SESSION_USDC: Number(optional("CAP_PER_SESSION_USDC", "10")),
  CAP_PER_DAY_USDC: Number(optional("CAP_PER_DAY_USDC", "50")),
  HITL_THRESHOLD_USDC: Number(optional("HITL_THRESHOLD_USDC", "1")),

  GIT_SHA: optional("GIT_SHA", "local-dev"),
  BUILD_TIME: optional("BUILD_TIME", new Date(0).toISOString()),
  ECLOUD_APP_ID: optional("ECLOUD_APP_ID"),
  ECLOUD_ATTESTATION_HASH: optional("ECLOUD_ATTESTATION_HASH"),

  HITL_AUTO_APPROVE: optional("HITL_AUTO_APPROVE", "false") === "true",

  // StableMerch order parameters. The agent reads these from env so the
  // model never sees / never generates a shipping address.
  STABLEMERCH_IMAGE_URL: optional("STABLEMERCH_IMAGE_URL"),
  STABLEMERCH_RECIPIENT_NAME: optional("STABLEMERCH_RECIPIENT_NAME"),
  STABLEMERCH_ADDRESS1: optional("STABLEMERCH_ADDRESS1"),
  STABLEMERCH_ADDRESS2: optional("STABLEMERCH_ADDRESS2"),
  STABLEMERCH_CITY: optional("STABLEMERCH_CITY"),
  STABLEMERCH_STATE: optional("STABLEMERCH_STATE"),
  STABLEMERCH_ZIP: optional("STABLEMERCH_ZIP"),
  STABLEMERCH_COUNTRY: optional("STABLEMERCH_COUNTRY", "US"),
  STABLEMERCH_SHIRT_SIZE: optional("STABLEMERCH_SHIRT_SIZE", "M"),
};

// A merchant offers one or more catalog resources. Each resource pins down
// the request shape (GET vs POST, body template, expected content) so the
// model never has to construct the wire format.
export type MerchantResource = {
  itemId: string;
  description: string;
  method: "GET" | "POST";
  url: string;
  expectedContentType: string;
  buildBody?: () => unknown;
  approxAmountUsdc: string;
};

export type Merchant = {
  id: string;
  name: string;
  baseUrl: string;
  resources: MerchantResource[];
};

const stableMerchAddress = () => {
  const required = [
    env.STABLEMERCH_RECIPIENT_NAME,
    env.STABLEMERCH_ADDRESS1,
    env.STABLEMERCH_CITY,
    env.STABLEMERCH_STATE,
    env.STABLEMERCH_ZIP,
  ];
  if (required.some((v) => !v)) {
    throw new Error(
      "StableMerch order missing shipping address. Set STABLEMERCH_RECIPIENT_NAME / ADDRESS1 / CITY / STATE / ZIP in .env.",
    );
  }
  return {
    name: env.STABLEMERCH_RECIPIENT_NAME,
    address1: env.STABLEMERCH_ADDRESS1,
    address2: env.STABLEMERCH_ADDRESS2 || undefined,
    city: env.STABLEMERCH_CITY,
    state_code: env.STABLEMERCH_STATE,
    zip: env.STABLEMERCH_ZIP,
    country_code: env.STABLEMERCH_COUNTRY,
  };
};

// Real merchants verified live on Base mainnet via x402scan.com (2026-05-11).
// payTo addresses + payment requirements are returned by each merchant's 402
// challenge — we don't need them client-side, but the URLs / methods / body
// templates do live here so the model can't deviate.
export const merchants: Merchant[] = [
  {
    id: "stablemerch",
    name: "StableMerch (Printful-shipped apparel)",
    baseUrl: "https://stablemerch.dev",
    resources: [
      {
        itemId: "stablemerch-shirt",
        description: "Custom AI-printed t-shirt, shipped via Printful (~$20)",
        method: "POST",
        url: "https://stablemerch.dev/api/shirt",
        expectedContentType: "application/json",
        approxAmountUsdc: "20",
        buildBody: () => {
          if (!env.STABLEMERCH_IMAGE_URL) {
            throw new Error(
              "STABLEMERCH_IMAGE_URL is unset. Provide a public image URL the printer will pull.",
            );
          }
          return {
            imageUrl: env.STABLEMERCH_IMAGE_URL,
            size: env.STABLEMERCH_SHIRT_SIZE,
            address_to: stableMerchAddress(),
          };
        },
      },
      {
        itemId: "stablemerch-mug",
        description: "Custom AI-printed mug, shipped via Printful (~$15)",
        method: "POST",
        url: "https://stablemerch.dev/api/mug",
        expectedContentType: "application/json",
        approxAmountUsdc: "15",
        buildBody: () => {
          if (!env.STABLEMERCH_IMAGE_URL) {
            throw new Error("STABLEMERCH_IMAGE_URL is unset.");
          }
          return { imageUrl: env.STABLEMERCH_IMAGE_URL, address_to: stableMerchAddress() };
        },
      },
    ],
  },
  {
    id: "satoshi",
    name: "Satoshi API (Bitcoin fee data)",
    baseUrl: "https://bitcoinsapi.com",
    resources: [
      {
        itemId: "btc-fees-now",
        description: "Current Bitcoin mempool fee snapshot ($0.001)",
        method: "GET",
        url: "https://bitcoinsapi.com/api/v1/fees/now",
        expectedContentType: "application/json",
        approxAmountUsdc: "0.001",
      },
    ],
  },
  {
    id: "twit-sh",
    name: "twit.sh (Twitter/X API)",
    baseUrl: "https://x402.twit.sh",
    resources: [
      {
        itemId: "x-user-lookup",
        description: "Twitter/X user lookup by username ($0.005)",
        method: "GET",
        url: "https://x402.twit.sh/users/by/username?username=jack",
        expectedContentType: "application/json",
        approxAmountUsdc: "0.005",
      },
    ],
  },
  {
    id: "reddit-surf",
    name: "Surf Reddit (Reddit API)",
    baseUrl: "https://reddit.surf.cascade.fyi",
    resources: [
      {
        itemId: "reddit-subreddit",
        description: "Subreddit info lookup ($0.001)",
        method: "GET",
        url: "https://reddit.surf.cascade.fyi/r/bitcoin",
        expectedContentType: "application/json",
        approxAmountUsdc: "0.001",
      },
    ],
  },
];

const allResources: MerchantResource[] = merchants.flatMap((m) =>
  m.resources.map((r) => ({ ...r, _merchantId: m.id })),
) as MerchantResource[];

export const catalog = allResources.map((r) => ({
  id: r.itemId,
  description: r.description,
  expectedContentType: r.expectedContentType,
  approxAmountUsdc: r.approxAmountUsdc,
}));

export const isAllowlistedUrl = (url: string): boolean =>
  merchants.some((m) => url.startsWith(m.baseUrl));

export const findMerchantByItem = (itemId: string): Merchant | undefined =>
  merchants.find((m) => m.resources.some((r) => r.itemId === itemId));

export const findResource = (itemId: string): MerchantResource | undefined =>
  allResources.find((r) => r.itemId === itemId);

export const findCatalogItem = (itemId: string) => catalog.find((c) => c.id === itemId);
