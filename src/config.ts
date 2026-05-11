import "dotenv/config";
import type { CatalogItem, Merchant } from "./types.js";

const required = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env: ${k}`);
  return v;
};
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
};

// Item catalog — v1 ships a fixed list. The model is never allowed to invent ids.
export const catalog: CatalogItem[] = [
  {
    id: "merch-tshirt",
    description: "StableMerch x402 t-shirt (any size, ships in 5 business days)",
    expectedContentType: "application/json",
  },
  {
    id: "demo-asset",
    description: "Small demo asset returned by an x402 merchant (image or JSON)",
  },
];

// Merchant allowlist. The agent refuses any URL not on this list.
// Populate from x402scan.com after we lock in a v1 merchant.
export const merchants: Merchant[] = [
  {
    id: "stablemerch",
    name: "StableMerch",
    baseUrl: "https://stablemerch.x402.dev",
    catalogItems: ["merch-tshirt"],
  },
];

export const isAllowlistedUrl = (url: string): boolean =>
  merchants.some((m) => url.startsWith(m.baseUrl));

export const findMerchantByItem = (itemId: string): Merchant | undefined =>
  merchants.find((m) => m.catalogItems.includes(itemId));

export const findCatalogItem = (itemId: string): CatalogItem | undefined =>
  catalog.find((i) => i.id === itemId);
