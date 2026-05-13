// Waitlist signup endpoint. Validates input, then writes to Supabase if
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set in the Vercel project env.
// Without them the endpoint accepts the submission and logs it — useful for
// preview deployments before the Supabase project is wired up.

const SUPPORTED_COUNTRIES = new Set(["in", "us", "gb", "eg", "za", "ng", "other"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "POST only" });
  }

  // Body parsing — Vercel doesn't auto-parse for Node functions.
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return json(res, 400, { error: "invalid JSON" });
    }
  }
  body = body || {};

  const email = String(body.email || "").trim().toLowerCase();
  const country = String(body.country || "").trim().toLowerCase();
  const intent = String(body.intent || "").trim().slice(0, 200);

  if (!EMAIL_RE.test(email)) return json(res, 400, { error: "invalid email" });
  if (!SUPPORTED_COUNTRIES.has(country)) return json(res, 400, { error: "invalid country" });

  const row = {
    email,
    country,
    intent: intent || null,
    user_agent: req.headers["user-agent"] || null,
    referer: req.headers["referer"] || null,
    created_at: new Date().toISOString(),
  };

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const table = process.env.SUPABASE_WAITLIST_TABLE || "waitlist";

  // Supabase not configured — accept and log. Lets the page work in preview
  // deploys before the database is provisioned.
  if (!url || !serviceKey) {
    console.log("[waitlist] (no supabase) signup:", row);
    return json(res, 200, {
      ok: true,
      stored: false,
      message: "✓ noted — we'll wire you up when the bot opens.",
    });
  }

  // Supabase write via REST. Avoids importing @supabase/supabase-js to keep
  // the function cold-start tiny (and dependency-free).
  try {
    const r = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        prefer: "return=minimal,resolution=merge-duplicates",
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("[waitlist] supabase insert failed", r.status, text.slice(0, 300));
      return json(res, 502, { error: "couldn't reach the list — try again in a sec" });
    }
    return json(res, 200, {
      ok: true,
      stored: true,
      message: "✓ on the list — you'll hear from us when the bot opens up.",
    });
  } catch (err) {
    console.error("[waitlist] supabase call threw", err);
    return json(res, 502, { error: "couldn't reach the list — try again in a sec" });
  }
}
