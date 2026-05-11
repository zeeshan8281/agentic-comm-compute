# agentic-commerce-compte

A single-agent reference implementation for protocol-native agentic commerce: takes a natural-language purchase request, discovers an x402-accepting merchant, negotiates price via the HTTP 402 challenge, settles in USDC on Base from a managed smart wallet, retrieves the asset, and returns it with a verifiable receipt.

The agent runs inside an [EigenCompute](https://docs.eigencloud.xyz/products/eigencompute) TEE-attested container, so any counterparty can verify the exact code that spent the money.

## Why this exists

Agentic commerce is being built on two tracks:

1. **Card-network rails retrofitted for agents** — Visa TAP, Mastercard Agentic Tokens, Stripe Issuing. Carry chargeback risk, a clearing window, and require partner programs gated by waitlists.
2. **Protocol-native rails** — [x402](https://www.x402.org/), AP2. Settle on the wire, work with any agent that speaks the protocol, and don't require permission to use.

The obvious "agent buys something on a storefront" demo (Visa CLI, Stripe Issuing wrapping a card network) hides what's actually new about agent-to-merchant payments. x402 makes the negotiation explicit at the protocol layer — the HTTP `402 Payment Required` response carries the quote, the agent settles on-chain, and the same request replays with an `x-payment` header to retrieve the asset. That's the path this repo demonstrates end-to-end.

## What it does

1. User submits a request: `{ item: "<catalog-id>", max_usdc: <cap> }`.
2. Agent calls `discover_offers` against an allowlisted set of x402 merchants.
3. Agent calls `fetch_quote`, receives the 402 challenge, rejects anything above the user cap.
4. Above 1 USDC, agent triggers a human-in-the-loop confirmation.
5. Agent calls `pay_x402`, which signs and broadcasts the USDC transfer on Base via the CDP smart wallet. Cloudflare's facilitator verifies on the merchant side.
6. Agent replays the request with the `x-payment` header, calls `retrieve_asset`, then `verify_delivery`.
7. Agent returns the asset and a receipt containing: Base tx hash, merchant URL, item, USDC amount, EigenCompute attestation hash, timestamp.

Every step is logged to Postgres and surfaced as a timeline in the demo UI.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    EigenCompute TEE container                  │
│                                                                │
│   ┌──────────────────────┐         ┌────────────────────────┐  │
│   │   Claude Sonnet 4.6  │ ──────▶ │   Tool loop            │  │
│   │   (tool use)         │         │   discover_offers      │  │
│   └──────────────────────┘         │   fetch_quote          │  │
│              │                     │   pay_x402             │  │
│              │                     │   retrieve_asset       │  │
│              ▼                     │   verify_delivery      │  │
│   ┌──────────────────────┐         └────────────────────────┘  │
│   │   Attestation        │                    │                │
│   │   (per-receipt)      │                    │                │
│   └──────────────────────┘                    │                │
└────────────────────────────────────────────────┼───────────────┘
                                                 │
                  ┌──────────────────────────────┼─────────────────┐
                  ▼                              ▼                 ▼
        ┌──────────────────┐         ┌──────────────────┐   ┌────────────┐
        │   x402 merchant  │         │   CDP Wallet     │   │  Postgres  │
        │   (allowlisted)  │         │   (Base, USDC,   │   │  (audit)   │
        │                  │         │    policy caps)  │   │            │
        └──────────────────┘         └──────────────────┘   └────────────┘
                  │
                  ▼
        ┌──────────────────┐
        │   Cloudflare     │
        │   x402           │
        │   facilitator    │
        └──────────────────┘
```

## Tools

| Tool | Purpose |
| --- | --- |
| `discover_offers` | Query the merchant allowlist for items matching the request. |
| `fetch_quote` | Make the initial GET to a merchant, parse the 402 challenge, return price and payment terms. |
| `pay_x402` | Sign and broadcast the USDC transfer on Base via CDP Wallet. Subject to policy caps. |
| `retrieve_asset` | Replay the request with the `x-payment` header; return the asset bytes. |
| `verify_delivery` | Validate the asset matches the quote (hash, content-type, size). |

## Guardrails

- **Hard wallet caps** at the CDP Wallet policy layer (not in agent code): 10 USDC per session, 50 USDC per day.
- **HITL confirmation** required for any payment above 1 USDC.
- **Merchant allowlist** in config. The agent refuses any URL not on the list. No dynamic discovery in v1.
- **Catalog-driven items.** No model-generated item identifiers ever reach a merchant.
- **Per-receipt attestation.** The TEE attestation is re-fetched on every run — never cached.

## Verifiability

Every receipt contains two hashes that anchor it:

- **Base tx hash** — the on-chain USDC settlement. Verifiable by any block explorer.
- **EigenCompute attestation hash** — the TEE measurement of the container that produced the receipt. Verifiable against the published image.

Together these mean a counterparty can confirm both *that the payment happened* and *what code requested it*.

## Status

Pre-implementation. PRD in `docs/PRD.md` (forthcoming).

## Roadmap

- **v1** (this week) — one merchant from the Coinbase x402 directory, one item type, full happy-path flow, timeline UI, audit log.
- **v2** (next week) — multi-merchant comparison. Agent calls `fetch_quote` against N endpoints in parallel and picks the cheapest valid one. Adds the "x402-native price discovery" framing.
- **Stretch** — side-by-side display of EigenCompute attestation and Base tx hash in the demo UI. The line that makes this not just-another-x402-demo: *this agent is running in a verifiable TEE, here's its attestation, and here's the USDC it spent.*

## Non-goals (v1)

- No card-network merchants (Stripe, Visa, Mastercard).
- No multi-agent orchestration.
- No free-form item input from the model.
- No fraud/dispute resolution. We rely on x402's settle-on-the-wire model and the merchant allowlist.

## References

- [x402 protocol](https://www.x402.org/) — Coinbase
- [EigenCompute](https://docs.eigencloud.xyz/products/eigencompute) — EigenLayr
- [CDP Wallet](https://docs.cdp.coinbase.com/) — Coinbase Developer Platform
- [Stripe Agentic Commerce](https://stripe.com/blog/agentic-commerce-suite) — context on the card-rail track we are explicitly not taking
- [Agent Payment Protocol War](https://blockeden.xyz/blog/2026/03/14/payment-giants-agent-protocol-war-visa-tap-google-ap2-coinbase-x402-paypal-ai-commerce/) — BlockEden landscape overview
