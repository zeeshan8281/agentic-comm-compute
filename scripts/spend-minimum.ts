// Minimum-spend live validation: pays the Rye intent fee ($0.02) and the
// Laso /auth fee ($0.001). Does NOT confirm orders, does NOT buy gift cards.
// Total spend: ~$0.021 USDC + ~$0.0001 gas on Base mainnet.
//
// Validates end-to-end: EIP-712 signing, base64url wire format, PAYMENT-
// SIGNATURE + X-PAYMENT dual headers, payment-response tx-hash decoding,
// and that each merchant's facilitator accepts our payload.
//
// Run:  npx tsx scripts/spend-minimum.ts

import "dotenv/config";
import { env } from "../src/config.js";
import { payAndRetrieve } from "../src/x402-client.js";
import { getWallet } from "../src/wallet.js";
import {
  buildCreateIntentBody,
  createIntentUrl as ryeCreateIntentUrl,
  getIntent as ryeGetIntent,
  type RyeIntent,
} from "../src/rye.js";
import {
  authUrl as lasoAuthUrl,
  searchGiftCardsUrl,
  lasoIdToken,
  type LasoGiftCard,
} from "../src/laso.js";

const banner = (msg: string) =>
  console.log(`\n${"━".repeat(60)}\n${msg}\n${"━".repeat(60)}`);

const main = async () => {
  const wallet = getWallet();
  banner(`Agent wallet: ${wallet.address}  (network=${env.X402_NETWORK})`);

  const network =
    env.X402_NETWORK === "base-sepolia" ? "eip155:84532" : "eip155:8453";

  // ───── RYE create-intent ($0.02) ───────────────────────────────────────
  banner(`Rye  ·  POST /v1/checkout-intents  ·  spend $0.02 USDC`);
  const buyer = {
    firstName: "Test",
    lastName: "User",
    email: "test@example.com",
    phone: "+15555550100",
    address1: "123 Test St",
    city: "San Francisco",
    province: "CA",
    postalCode: "94103",
    country: "US",
  };
  const ryeBody = buildCreateIntentBody({
    productUrl: "https://allbirds.com/products/mens-wool-runners",
    quantity: 1,
    buyer,
    network,
  });
  const ryeStart = Date.now();
  const ryeRes = await payAndRetrieve({
    url: ryeCreateIntentUrl,
    method: "POST",
    body: ryeBody,
  });
  const ryeRaw = await ryeRes.response.text();
  const ryeIntent = JSON.parse(ryeRaw) as RyeIntent;
  console.log(`  ✓ paid in ${Date.now() - ryeStart}ms`);
  console.log(`  tx        : ${ryeRes.txHash}`);
  console.log(`  raw       : ${ryeRaw.slice(0, 300)}`);
  console.log(`  intent id : ${ryeIntent.id}`);
  console.log(`  state     : ${ryeIntent.state}`);

  // Free GETs — poll until the offer materializes or we time out.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const fetched = await ryeGetIntent(ryeIntent.id, wallet.address);
      console.log(`  poll ${i + 1}    : state=${fetched.state}, offer=${JSON.stringify(fetched.offer ?? null)}`);
      if (fetched.state === "awaiting_confirmation" || fetched.state === "failed") break;
    } catch (err) {
      console.log(`  poll ${i + 1} err : ${err instanceof Error ? err.message : err}`);
    }
  }

  // ───── LASO /auth ($0.001) ─────────────────────────────────────────────
  banner(`Laso  ·  GET /auth  ·  spend $0.001 USDC`);
  const lasoStart = Date.now();
  const lasoAuthResp = await payAndRetrieve({ url: lasoAuthUrl, method: "GET" });
  const lasoRaw = await lasoAuthResp.response.text();
  console.log(`  ✓ paid in ${Date.now() - lasoStart}ms`);
  console.log(`  tx           : ${lasoAuthResp.txHash}`);
  console.log(`  raw          : ${lasoRaw}`);
  const lasoAuth = JSON.parse(lasoRaw) as unknown;
  const idToken = lasoIdToken(lasoAuth);
  console.log(`  detected id_token: ${idToken ? idToken.slice(0, 24) + "…" : "(none — see raw above)"}`);
  if (!idToken) {
    throw new Error("Laso /auth returned no id_token; cannot proceed to search.");
  }

  // Free search — verify the token works on a non-paywalled endpoint.
  banner(`Laso  ·  GET /search-gift-cards?q=amazon  ·  free (Bearer)`);
  const searchRes = await fetch(searchGiftCardsUrl("amazon", "US"), {
    headers: { accept: "application/json", authorization: `Bearer ${idToken}` },
  });
  console.log(`  status: ${searchRes.status}`);
  const searchRaw = await searchRes.text();
  console.log(`  raw   : ${searchRaw.slice(0, 600)}`);
  if (searchRes.ok) {
    const body = JSON.parse(searchRaw) as { results?: LasoGiftCard[] } | LasoGiftCard[];
    const cards = Array.isArray(body) ? body : (body.results ?? []);
    console.log(`  cards returned: ${cards.length}`);
    cards.slice(0, 3).forEach((c) =>
      console.log(`    · ${c.laso_server_id} — ${c.name} (${c.currency ?? "USD"}, ${c.min ?? "?"}–${c.max ?? "?"})`),
    );
  }

  banner("Done. Total spend ≈ $0.021 USDC.  No orders placed.");
};

main().catch((err) => {
  console.error("\n✗ Spend-minimum failed:", err);
  process.exit(1);
});
