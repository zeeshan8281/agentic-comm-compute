// Laso Finance agent-native commerce: US prepaid cards, gift cards across
// 1000+ brands, push-to-debit USD/EUR/GBP. v1 wires gift cards only — the
// most analogous surface to Cryptorefills for the US market.
//
// Flow per Laso's SKILL.md:
//   1. GET /auth — x402-paywalled at $0.001. Returns nested { auth: {
//      id_token, refresh_token, expires_in }, user_id, callable_base_url }.
//      id_token is a Bearer for the free endpoints (/search-gift-cards,
//      /get-card-data). Expires in ~1h.
//   2. GET /search-gift-cards?q=...&country=US — returns laso_server_id +
//      denomination ranges. Free, needs Bearer.
//   3. GET /order-gift-card?amount=...&laso_server_id=...&country=US — x402-
//      paywalled at face value. Returns { redemption_code | redemption_url }.

const BASE_URL = "https://laso.finance";

// Real shape confirmed live: tokens are nested under `auth`, not flat. The
// previous flat assumption produced `Bearer undefined` on search-gift-cards.
export type LasoAuthResponse = {
  auth: {
    id_token: string;
    refresh_token: string;
    expires_in?: number;
  };
  user_id?: string;
  callable_base_url?: string;
};

// Extract the bearer token regardless of which shape the server happens to
// return — keeps callers from spelunking through nested fields.
export const lasoIdToken = (resp: unknown): string | undefined => {
  if (!resp || typeof resp !== "object") return undefined;
  const r = resp as Record<string, unknown>;
  const nested = (r.auth as Record<string, unknown> | undefined)?.id_token;
  if (typeof nested === "string") return nested;
  if (typeof r.id_token === "string") return r.id_token;
  if (typeof r.idToken === "string") return r.idToken;
  if (typeof r.token === "string") return r.token;
  return undefined;
};

// Real shape confirmed live: top-level wrapper is `gift_cards`, denomination
// fields are `min`/`max`/`increment` (not `min_amount`/`max_amount`).
export type LasoGiftCard = {
  laso_server_id: string;
  name: string;
  description?: string | null;
  country?: string;
  currency?: string;
  min?: number;
  max?: number;
  increment?: string;
  denominations?: number[] | null;
  product_image_url?: string | null;
  catalog_info?: Record<string, unknown> | null;
};

export type LasoGiftOrder = {
  card_id?: string;
  laso_server_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  redemption_code?: string;
  redemption_pin?: string;
  redemption_url?: string;
  expires_at?: string;
  instructions?: string;
};

export const authUrl = `${BASE_URL}/auth`;
export const searchGiftCardsUrl = (q: string | undefined, country: string | undefined) => {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (country) params.set("country", country);
  const qs = params.toString();
  return `${BASE_URL}/search-gift-cards${qs ? `?${qs}` : ""}`;
};
export const orderGiftCardUrl = (opts: { amount: number; lasoServerId: string; country?: string }) => {
  const params = new URLSearchParams();
  params.set("amount", String(opts.amount));
  params.set("laso_server_id", opts.lasoServerId);
  if (opts.country) params.set("country", opts.country);
  return `${BASE_URL}/order-gift-card?${params.toString()}`;
};
export const baseUrl = BASE_URL;

export const searchGiftCards = async (
  idToken: string,
  opts: { q?: string; country?: string } = {},
): Promise<LasoGiftCard[]> => {
  const res = await fetch(searchGiftCardsUrl(opts.q, opts.country), {
    headers: { accept: "application/json", authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GET search-gift-cards ${res.status}: ${t.slice(0, 300)}`);
  }
  const body = (await res.json()) as
    | { gift_cards?: LasoGiftCard[]; results?: LasoGiftCard[] }
    | LasoGiftCard[];
  if (Array.isArray(body)) return body;
  return body.gift_cards ?? body.results ?? [];
};
