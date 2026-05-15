# Handoff — pick up here

Waitlist → Supabase is wired and verified end-to-end as of 2026-05-13. Smoke test landed a row; `select count(*)` returned 1.

## Live surfaces

| Surface  | URL                                            | Notes                                  |
| -------- | ---------------------------------------------- | -------------------------------------- |
| Landing  | https://eigen-commerce.vercel.app              | static, `apps/frontend/public/`        |
| Waitlist | https://agentic-commerce-waitlist.vercel.app   | Vercel Node fn → Supabase (LIVE)       |
| TEE      | https://35-186-152-24.sslip.io                 | EigenCompute, `/health` returns 200    |

Both Vercel apps had Deployment Protection disabled. Design system was rewritten to match `Layr-Labs/eigen-design` tokens (light theme, `#1a0c6d` indigo, Geist/Geist Mono, small radii).

## Supabase

- Project: **agentic-commerce-eigen**
- Project ref: `aktopkocuzwxkcnydahb`
- URL: `https://aktopkocuzwxkcnydahb.supabase.co`
- MCP server: configured at `/.mcp.json` (repo root), user already authed via `claude /mcp`. Tools should be available in new session as `mcp__supabase__*`.

## Pending — finish in this order

### 1. Create the `waitlist` table

Use the Supabase MCP (`mcp__supabase__execute_sql` or similar). The waitlist Vercel function at `apps/waitlist/api/signup.js` expects these exact columns:

```sql
create table public.waitlist (
  id          bigserial primary key,
  email       text not null,
  country     text not null,
  intent      text,
  user_agent  text,
  referer     text,
  created_at  timestamptz not null default now(),
  unique (email)
);
alter table public.waitlist enable row level security;
-- No policies. service_role bypasses RLS — anon/publishable will be locked out (intended).
```

### 2. Set Vercel env vars on the waitlist project

Project name: `waitlist` (slug `zeeshan8281s-projects/waitlist`, id `prj_u9eEHlIN0slpDXThfHHV6h50zkw5`).

Get the `service_role` key via Supabase MCP (or ask user — it's at *Supabase → Project Settings → API*). Then from `apps/waitlist/`:

```bash
echo "https://aktopkocuzwxkcnydahb.supabase.co" | vercel env add SUPABASE_URL production
echo "<service_role>" | vercel env add SUPABASE_SERVICE_ROLE_KEY production
```

Don't commit the service_role to any file. The waitlist function reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and optional `SUPABASE_WAITLIST_TABLE` (defaults to `waitlist`).

### 3. Redeploy waitlist + re-alias

```bash
cd apps/waitlist
vercel deploy --prod --yes
# grab the new deployment URL from output, then:
vercel alias set https://<new-deploy>.vercel.app agentic-commerce-waitlist.vercel.app
```

### 4. Verify end-to-end

```bash
curl -sS -X POST https://agentic-commerce-waitlist.vercel.app/api/signup \
  -H 'content-type: application/json' \
  -d '{"email":"smoketest+'"$(date +%s)"'@example.com","country":"in","intent":"smoke"}'
# expect {"ok":true,"stored":true,...}
```

Then via Supabase MCP query `select count(*) from waitlist` and confirm the row landed.

## Vercel project IDs (for reference)

- Frontend: `prj_X4TXXA5bBgr1ULj6hcbj4AcmHLEQ` (team `team_d2iNytjMuKmgbHLvTAewMSR4`)
- Waitlist: `prj_u9eEHlIN0slpDXThfHHV6h50zkw5`

## Repo state

Branch: `main`. Uncommitted changes from the deploy work (Dockerfile, Caddyfile, attestation TLS, `.env.deploy`, new CSS for both apps). User has not asked for a commit yet — don't commit unless asked.
