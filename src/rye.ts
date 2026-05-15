// Rye Universal Checkout via x402 v2. Lets the agent buy any product URL
// (Shopify, Walmart, 15k+ merchants — Amazon listings are gated by Rye).
//
// Three-phase flow:
//   1. POST /v1/checkout-intents { productUrl, quantity, buyer, paymentMethod }
//      → 402 with $0.02 fee. Sign + retry → 201 { id, state: 'retrieving_offer' }.
//   2. GET /v1/checkout-intents?id=... with X-Wallet-Address. Poll until state
//      becomes 'awaiting_confirmation' — payload now has price + shipping + tax.
//   3. POST /v1/checkout-intents/confirm { id, paymentMethod } → 402 with the
//      full order total + $0.03 API fee. Sign + retry → 200, then poll until
//      state is 'completed' or 'failed'. Final payload carries orderId.

const BASE_URL = "https://x402.rye.com";

// Rye's buyer schema is flat with Rye-flavored field names. Confirmed live
// (each via a 422 response):
//   - shippingAddress nested object → rejected as excess property
//   - line1/state → rejected as excess; want address1/province instead
//   - postalCode + country are required at the top level
// city, email, firstName, lastName, phone are accepted as-is.
export type RyeBuyer = {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  address1: string;
  address2?: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
};

// Real shape confirmed live: each cost line is { amountSubunits: number,
// currencyCode: "USD" }. amountSubunits is in the currency's minor units
// (cents for USD), so $119.49 arrives as 11949. The agent must divide by
// 100 to compare against USDC caps.
export type RyeMoney = { amountSubunits: number; currencyCode: string };

export type RyeIntent = {
  id: string;
  state:
    | "retrieving_offer"
    | "awaiting_confirmation"
    | "placing_order"
    | "completed"
    | "failed"
    | string;
  offer?: {
    cost?: {
      subtotal?: RyeMoney;
      tax?: RyeMoney;
      total?: RyeMoney;
      discount?: RyeMoney;
      shipping?: RyeMoney;
    };
    shipping?: {
      availableOptions?: Array<{
        id: string;
        cost: RyeMoney;
        deliveryEstimate?: string | null;
      }>;
      selectedOptionId?: string;
    };
  };
  orderId?: string;
  error?: string;
};

// Convert a RyeMoney (subunits) to a USDC-comparable decimal string in major
// units. Rye returns USD; we treat 1 USD == 1 USDC for caps + HITL routing.
export const ryeTotalUsdc = (intent: RyeIntent): number | undefined => {
  const subunits = intent.offer?.cost?.total?.amountSubunits;
  if (typeof subunits !== "number") return undefined;
  return subunits / 100;
};

export const createIntentUrl = `${BASE_URL}/v1/checkout-intents`;
export const confirmIntentUrl = `${BASE_URL}/v1/checkout-intents/confirm`;
export const baseUrl = BASE_URL;

// Rye's request body validates network against short names ("base", "solana",
// "tempo"), but the x402 v2 challenge in the 402 response uses CAIP-2 ids
// ("eip155:8453"). The two encodings live in different layers — the body
// names the network for the merchant's order routing, the challenge names
// it for the signer's EIP-712 domain. We accept either form here and emit
// the short form Rye's body validator wants.
const toRyeNetworkShort = (network: string): "base" | "solana" | "tempo" => {
  if (network === "base" || network === "eip155:8453" || network === "eip155:84532") return "base";
  if (network.startsWith("solana:")) return "solana";
  if (network === "tempo" || network === "eip155:4217") return "tempo";
  throw new Error(`Unsupported Rye network: ${network}`);
};

export const buildCreateIntentBody = (opts: {
  productUrl: string;
  quantity: number;
  buyer: RyeBuyer;
  network: string;
}) => ({
  productUrl: opts.productUrl,
  quantity: opts.quantity,
  buyer: opts.buyer,
  paymentMethod: { type: "x402", network: toRyeNetworkShort(opts.network) },
});

export const buildConfirmBody = (opts: { id: string; network: string }) => ({
  id: opts.id,
  paymentMethod: { type: "x402", network: toRyeNetworkShort(opts.network) },
});

export const getIntent = async (
  id: string,
  walletAddress: string,
): Promise<RyeIntent> => {
  const url = `${BASE_URL}/v1/checkout-intents?id=${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "X-Wallet-Address": walletAddress },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GET ${url} ${res.status}: ${t.slice(0, 300)}`);
  }
  return (await res.json()) as RyeIntent;
};

// Block until the intent reaches a target state (or a terminal failure).
// `until` is the list of states to stop polling on; defaults to the natural
// terminal/decision points.
export const pollIntent = async (
  id: string,
  walletAddress: string,
  opts: {
    until?: Array<RyeIntent["state"]>;
    timeoutMs?: number;
    intervalMs?: number;
    onTick?: (r: RyeIntent) => void;
  } = {},
): Promise<RyeIntent> => {
  const until = opts.until ?? ["awaiting_confirmation", "completed", "failed"];
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const started = Date.now();
  let last: RyeIntent | undefined;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await getIntent(id, walletAddress);
      opts.onTick?.(last);
      if (until.includes(last.state)) return last;
    } catch {
      // transient — try again
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Intent ${id} did not reach ${until.join("|")} within ${timeoutMs}ms (last=${last?.state ?? "unknown"})`,
  );
};
