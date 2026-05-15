// Dry-run probe for the Rye + Laso wire formats. NEVER signs, NEVER pays.
// Just sends the same request the agent will, reads back the 402 challenge
// (or 4xx error), and prints what the merchant told us.
//
// Run:  npx tsx scripts/probe-commerce.ts

import {
  buildCreateIntentBody,
  buildConfirmBody,
  createIntentUrl as ryeCreateIntentUrl,
  confirmIntentUrl as ryeConfirmIntentUrl,
  baseUrl as ryeBaseUrl,
} from "../src/rye.js";
import {
  authUrl as lasoAuthUrl,
  searchGiftCardsUrl,
  orderGiftCardUrl,
} from "../src/laso.js";

type ProbeResult = {
  label: string;
  url: string;
  method: string;
  status: number;
  challenge?: unknown;
  bodyPreview?: string;
  paymentRequiredHeader?: string | null;
};

const decodeChallenge = (raw: string | null) => {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    try {
      const json = Buffer.from(raw, "base64").toString("utf8");
      return JSON.parse(json);
    } catch {
      return raw;
    }
  }
};

const probe = async (
  label: string,
  url: string,
  init: RequestInit & { body?: BodyInit | null } = {},
): Promise<ProbeResult> => {
  const res = await fetch(url, init);
  const txt = await res.text();
  const pr = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
  return {
    label,
    url,
    method: (init.method ?? "GET").toString(),
    status: res.status,
    paymentRequiredHeader: pr ? "(present)" : null,
    challenge: pr ? decodeChallenge(pr) : undefined,
    bodyPreview: txt.slice(0, 600),
  };
};

const main = async () => {
  console.log(`\n--- Rye base: ${ryeBaseUrl}`);

  // 1. Rye create-intent — body shape we'll actually send.
  const buyer = {
    firstName: "Test",
    lastName: "User",
    email: "test@example.com",
    phone: "+15555550100",
    shippingAddress: {
      line1: "123 Test St",
      city: "San Francisco",
      state: "CA",
      postalCode: "94103",
      country: "US",
    },
  };
  const createBody = buildCreateIntentBody({
    productUrl: "https://allbirds.com/products/mens-wool-runners",
    quantity: 1,
    buyer,
    network: "eip155:8453",
  });
  const ryeCreate = await probe("rye POST /v1/checkout-intents", ryeCreateIntentUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(createBody),
  });

  // 2. Rye confirm — even with a fake intent id, the 402 tells us the route
  //    accepts our body shape.
  const ryeConfirm = await probe("rye POST /v1/checkout-intents/confirm", ryeConfirmIntentUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(buildConfirmBody({ id: "ci_dryrun", network: "eip155:8453" })),
  });

  console.log(`\n--- Laso ---`);
  const lasoAuth = await probe("laso GET /auth", lasoAuthUrl, { method: "GET" });
  const lasoSearch = await probe(
    "laso GET /search-gift-cards (no auth — expect 401)",
    searchGiftCardsUrl("amazon", "US"),
    { method: "GET" },
  );
  const lasoOrder = await probe(
    "laso GET /order-gift-card",
    orderGiftCardUrl({ amount: 25, lasoServerId: "amazon-us", country: "US" }),
    { method: "GET" },
  );

  for (const r of [ryeCreate, ryeConfirm, lasoAuth, lasoSearch, lasoOrder]) {
    console.log(`\n# ${r.label}`);
    console.log(`  ${r.method} ${r.url}`);
    console.log(`  → status ${r.status}, payment-required header: ${r.paymentRequiredHeader ?? "absent"}`);
    if (r.challenge) {
      console.log(`  challenge: ${JSON.stringify(r.challenge, null, 2).slice(0, 800)}`);
    }
    if (!r.challenge && r.bodyPreview) {
      console.log(`  body: ${r.bodyPreview}`);
    }
  }
};

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
