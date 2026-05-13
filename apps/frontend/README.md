# agentic-commerce frontend

Static landing + demo, deployed to Vercel. All `/api/*`, `/verify`, and
`/health` requests are rewritten by Vercel's edge to the EigenCompute TEE
backend — same-origin from the browser, no CORS, SSE preserved.

## One-time setup

1. Deploy the backend to EigenCompute first (see repo-root `README.md`),
   then grab its public URL:

   ```bash
   ecloud compute app list
   ecloud compute app info <APP_ID>
   ```

   The URL is shown as `Public URL` — strip the scheme, you want the host,
   e.g. `abc123-8080.ecloud.run`.

2. Replace the placeholder in `vercel.json`:

   ```bash
   cd apps/frontend
   sed -i '' 's|EIGEN_BACKEND_HOST_PLACEHOLDER|abc123-8080.ecloud.run|g' vercel.json
   ```

   (Linux: drop the empty `''` after `-i`.)

3. Deploy:

   ```bash
   vercel link    # one-time, pick a new project name
   vercel --prod
   ```

## Local preview

```bash
cd apps/frontend
vercel dev
# http://localhost:3000 — rewrites work locally too.
```

## When the TEE redeploys

If you redeploy the agent (new EigenCompute app id), update the host in
`vercel.json` and `vercel --prod` again. The TEE URL is the stable
identifier; the Vercel URL stays the same.
