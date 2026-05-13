# agentic-commerce waitlist

Standalone Vercel deployment. Separate project from `apps/frontend` so the
waitlist domain can come up before the TEE backend is live.

## Layout

```
public/         — static landing + form (no framework)
api/signup.js   — POST endpoint. Writes to Supabase if configured, otherwise
                  accepts and logs.
vercel.json     — output dir + security headers
.env.example    — Supabase config slots
```

## Deploy

```bash
cd apps/waitlist
vercel link        # one-time: pick a new project name (e.g. "agentic-commerce-waitlist")
vercel --prod
```

## Supabase wiring

1. Create a Supabase project (any region).
2. SQL editor → run:
   ```sql
   create table if not exists waitlist (
     id           bigint generated always as identity primary key,
     email        text not null,
     country      text not null,
     intent       text,
     user_agent   text,
     referer      text,
     created_at   timestamptz not null default now(),
     unique (email)
   );
   alter table waitlist enable row level security;
   -- only the service role can insert; no anon access.
   ```
3. Vercel project → Settings → Environment Variables:
   - `SUPABASE_URL` = your project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = service-role secret (NOT the anon key)
   - (optional) `SUPABASE_WAITLIST_TABLE` if you renamed the table
4. Redeploy: `vercel --prod`.

Until the env vars are set, the form still works — submissions are accepted
and logged to the Vercel function logs, which is fine for early link sharing.

## Local preview

```bash
cd apps/waitlist
vercel dev
# http://localhost:3000
```
