// Cryptorefills agent-native commerce: 144 brands in India alone (Swiggy,
// Zomato, Phonepe, Airtel/Jio/Vi, Google Play, MakeMyTrip, etc.) plus 10k+
// global brands, all settling in USDC on Base via x402 v2.
//
// Two-phase flow:
//   1. POST /v1/orders without payment → 402 challenge with the USDC quote.
//   2. POST /v1/orders with PAYMENT-SIGNATURE → 200 with { order_id }.
//   3. Poll GET /v1/orders/{order_id} until status === 'completed' to read
//      deliveries[].voucher_code.

const BASE_URL = "https://x402.cryptorefills.com";

export type CrBrand = {
  brand_name: string;
  family: string;
  category: string;
  min: string;
  max: string;
};

export type CrProduct = {
  product_id: string;
  product_name: string;
  brand_name: string;
  denomination: string;
  denomination_label: string;
  currency: string;
  is_range: boolean;
  face_value_usd: number;
  price_usdc: string;
  country_code: string;
  type: string;
};

export type CrDelivery = {
  product_id?: string;
  voucher_code?: string;
  voucher_pin?: string;
  serial_number?: string;
  expiry_date?: string;
  redemption_instructions?: string;
};

export type CrOrderResponse = {
  order_id: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled" | string;
  total_usdc?: string;
  deliveries?: CrDelivery[];
};

const getJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GET ${url} ${res.status}: ${t.slice(0, 300)}`);
  }
  return (await res.json()) as T;
};

export const listBrands = (countryCode: string): Promise<CrBrand[]> =>
  getJson<CrBrand[]>(`${BASE_URL}/v1/brands?country_code=${encodeURIComponent(countryCode)}`);

export const listProducts = (countryCode: string, brandName: string): Promise<CrProduct[]> =>
  getJson<CrProduct[]>(
    `${BASE_URL}/v1/catalog?country_code=${encodeURIComponent(countryCode)}&brand_name=${encodeURIComponent(brandName)}`,
  );

export const getOrder = (orderId: string): Promise<CrOrderResponse> =>
  getJson<CrOrderResponse>(`${BASE_URL}/v1/orders/${encodeURIComponent(orderId)}`);

// Poll until terminal status. Cryptorefills typically delivers digital codes
// in 5-30 seconds; physical mobile recharges can take a few minutes.
export const pollUntilSettled = async (
  orderId: string,
  opts: { timeoutMs?: number; intervalMs?: number; onTick?: (r: CrOrderResponse) => void } = {},
): Promise<CrOrderResponse> => {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 4_000;
  const started = Date.now();
  let last: CrOrderResponse | undefined;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await getOrder(orderId);
      opts.onTick?.(last);
      if (last.status === "completed" || last.status === "failed" || last.status === "cancelled") {
        return last;
      }
    } catch {
      // transient — try again
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Order ${orderId} did not reach terminal status within ${timeoutMs}ms (last=${last?.status ?? "unknown"})`,
  );
};

export const ordersUrl = `${BASE_URL}/v1/orders`;
export const baseUrl = BASE_URL;
