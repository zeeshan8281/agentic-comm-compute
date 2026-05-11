import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pino from "pino";
import { env, merchants, catalog } from "./config.js";
import { runAgent } from "./agent.js";
import { getSession } from "./events.js";
import { resolveApproval, getPendingPrompt } from "./hitl.js";
import { readAttestation } from "./attestation.js";
import { listReceipts, getReceipt } from "./receipts.js";
import { getWallet } from "./wallet.js";

const log = pino({ level: env.LOG_LEVEL });
const app = express();
app.use(express.json({ limit: "256kb" }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
app.use(express.static(publicDir));

// Health + attestation surface. The PRD requires per-receipt attestation; this
// endpoint is the standing copy that any counterparty can pull at any time.
app.get("/verify", (_req, res) => {
  let walletAddress: string | null = null;
  try {
    walletAddress = getWallet().address;
  } catch {
    walletAddress = null;
  }
  res.json({
    service: env.SERVICE_NAME,
    attestation: readAttestation(),
    network: env.X402_NETWORK,
    walletAddress,
    merchants: merchants.map((m) => ({ id: m.id, baseUrl: m.baseUrl })),
    catalog: catalog.map((c) => ({ id: c.id, description: c.description })),
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// SSE: stream the timeline for a session. The UI subscribes immediately after
// kicking off /api/run so the user sees every tool call as it happens.
app.get("/api/events", (req, res) => {
  const sessionId = String(req.query.sessionId ?? "");
  if (!sessionId) return res.status(400).end("sessionId required");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const session = getSession(sessionId);
  for (const ev of session.history) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const onEvent = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  session.on("event", onEvent);
  req.on("close", () => session.off("event", onEvent));
});

app.post("/api/run", async (req, res) => {
  const item = String(req.body?.item ?? "");
  const maxUsdc = Number(req.body?.maxUsdc ?? 0);
  const sessionId = String(req.body?.sessionId ?? "");
  if (!item || !sessionId || !Number.isFinite(maxUsdc) || maxUsdc <= 0) {
    return res.status(400).json({ error: "Required: { sessionId, item, maxUsdc }" });
  }
  try {
    const receipt = await runAgent({ sessionId, item, maxUsdc });
    res.json({ receipt });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, "run failed");
    getSession(sessionId).emitEvent({ kind: "error", message: msg });
    res.status(500).json({ error: msg });
  }
});

app.post("/api/confirm", (req, res) => {
  const sessionId = String(req.body?.sessionId ?? "");
  const approved = Boolean(req.body?.approved);
  const ok = resolveApproval(sessionId, approved);
  res.json({ ok, prompt: getPendingPrompt(sessionId) });
});

app.get("/api/receipts", (_req, res) => res.json({ receipts: listReceipts() }));

app.get("/api/receipts/:id", (req, res) => {
  const r = getReceipt(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json({ receipt: r });
});

app.listen(env.PORT, () => {
  const att = readAttestation();
  log.info(
    {
      port: env.PORT,
      service: env.SERVICE_NAME,
      attestationSource: att.source,
      gitSha: att.gitSha,
      model: env.AGENT_MODEL,
      network: env.X402_NETWORK,
    },
    "agent ready",
  );
});
