// Cheap Laso-only probe: pay /auth ($0.001), then call /search-gift-cards a
// few different ways to map the response shape.  Run: npx tsx scripts/probe-laso-search.ts

import "dotenv/config";
import { payAndRetrieve } from "../src/x402-client.js";
import {
  authUrl as lasoAuthUrl,
  searchGiftCardsUrl,
  lasoIdToken,
} from "../src/laso.js";

const main = async () => {
  const { response } = await payAndRetrieve({ url: lasoAuthUrl, method: "GET" });
  const raw = await response.text();
  const token = lasoIdToken(JSON.parse(raw));
  if (!token) throw new Error(`no id_token in ${raw}`);
  console.log(`token: ${token.slice(0, 24)}…\n`);

  const probes = [
    searchGiftCardsUrl(undefined, "US"),
    searchGiftCardsUrl("amazon", "US"),
    searchGiftCardsUrl("Amazon", "US"),
    searchGiftCardsUrl(undefined, undefined),
    `https://laso.finance/search-gift-cards`,
  ];

  for (const url of probes) {
    const r = await fetch(url, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    const body = await r.text();
    console.log(`GET ${url}`);
    console.log(`  → ${r.status}`);
    console.log(`  body: ${body.slice(0, 500)}\n`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
