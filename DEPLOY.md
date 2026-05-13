# Deploying agentic-commerce

Three surfaces, three deploys. Run them in order.

```
1. Backend  → EigenCompute TEE          (the agent + Telegram bot)
2. Frontend → Vercel (proxies → TEE)    (marketing landing + demo)
3. Waitlist → Vercel (own project)      (email capture, Supabase-backed)
```

---

## 1) EigenCompute TEE backend

### Prereqs

- `ecloud` CLI ≥ 0.4.3 (`ecloud --version`)
- Docker with `linux/amd64` build support
- A container registry you can push to (Docker Hub or GHCR work)

```bash
ecloud auth login
ecloud auth whoami        # prints your wallet address
```

### Build & push the image

Use the existing `Dockerfile` at the repo root. The image must be linux/amd64
and listen on `0.0.0.0:8080` (the app already does).

Pick a registry path. Examples below use GHCR:

```bash
export IMAGE=ghcr.io/<your-gh-user>/agentic-commerce:$(git rev-parse --short HEAD)

# If you haven't yet:
echo $GHCR_PAT | docker login ghcr.io -u <your-gh-user> --password-stdin

docker build --platform linux/amd64 \
  --build-arg GIT_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_TIME=$(date -u +%FT%TZ) \
  -t $IMAGE .

docker push $IMAGE
```

Sanity-check the image runs locally:

```bash
docker run --rm --platform linux/amd64 -p 8080:8080 \
  --env-file .env $IMAGE
# then in another shell:
curl -s http://localhost:8080/health
```

### Deploy to EigenCompute

Read the eigen-skills runbook (`/eigen-skills`) for the why behind each flag.

```bash
# Empty .env is fine — we'll set sealed secrets in the next step.
touch .env.deploy

# Remove the Dockerfile from the working dir so ecloud doesn't try to
# rebuild it locally — we already pushed the image.
mv Dockerfile .Dockerfile.bak

echo "n" | ecloud compute app deploy \
  --name agentic-commerce \
  --image-ref $IMAGE \
  --skip-profile \
  --env-file .env.deploy \
  --instance-type g1-standard-4t \
  --log-visibility public \
  --resource-usage-monitoring enable \
  --verbose

mv .Dockerfile.bak Dockerfile
```

Capture the printed APP_ID. Get the public URL:

```bash
ecloud compute app info <APP_ID>
# Public URL → e.g. https://<some-host>.ecloud.run
```

### Set sealed secrets

These never appear in logs and are only decryptable inside the TEE.

```bash
APP_ID=<from previous step>

ecloud compute app env set --app $APP_ID \
  ANTHROPIC_API_KEY="sk-ant-…" \
  AGENT_PRIVATE_KEY="0x…" \
  AGENT_WALLET_ADDRESS="0x…" \
  X402_NETWORK="base" \
  BASE_RPC_URL="https://mainnet.base.org" \
  CAP_PER_PAYMENT_USDC="5" \
  CAP_PER_SESSION_USDC="50" \
  CAP_PER_DAY_USDC="200" \
  HITL_THRESHOLD_USDC="0.5" \
  CRYPTOREFILLS_COUNTRY="in" \
  CRYPTOREFILLS_EMAIL="you@example.com" \
  CRYPTOREFILLS_BENEFICIARY="+91…" \
  TELEGRAM_BOT_TOKEN="…:…" \
  TELEGRAM_BOT_USERNAME="ac_eigen_bot"
```

Restart to pick up the new sealed env:

```bash
ecloud compute app upgrade $APP_ID
```

Verify:

```bash
curl -s https://<host>.ecloud.run/health
curl -s https://<host>.ecloud.run/verify | jq
# attestation.source should be "tee" (not "local-dev")
```

Attestation portal: <https://verify-sepolia.eigencloud.xyz/app/$APP_ID>

---

## 2) Vercel frontend (proxy → TEE)

```bash
cd apps/frontend

# Swap the placeholder for your TEE host. Mac:
sed -i '' 's|EIGEN_BACKEND_HOST_PLACEHOLDER|<host>.ecloud.run|g' vercel.json
# Linux:
# sed -i 's|EIGEN_BACKEND_HOST_PLACEHOLDER|<host>.ecloud.run|g' vercel.json

vercel link       # pick a new project name, e.g. "agentic-commerce"
vercel --prod
```

That URL is now your marketing site. `/api/*`, `/verify`, and `/health`
get rewritten to the TEE — same origin in the browser, no CORS issues,
SSE streaming preserved.

---

## 3) Vercel waitlist (separate project)

```bash
cd apps/waitlist
vercel link       # pick "agentic-commerce-waitlist"
vercel --prod
```

The page works immediately — submissions are logged to function logs.

To persist them, create a Supabase project, run the SQL in
`apps/waitlist/README.md`, then set these env vars in the Vercel project
settings and redeploy:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_WAITLIST_TABLE   (optional, defaults to "waitlist")
```

---

## Cheat sheet

```bash
# TEE
ecloud compute app list
ecloud compute app logs <APP_ID>
ecloud compute app info <APP_ID>
ecloud compute app upgrade <APP_ID>          # restart after env change
ecloud compute app stop <APP_ID>
echo y | ecloud compute app terminate <APP_ID>

# Vercel
cd apps/frontend && vercel --prod
cd apps/waitlist && vercel --prod
```
