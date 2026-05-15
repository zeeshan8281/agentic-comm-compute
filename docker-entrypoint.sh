#!/bin/sh
set -e

# Wait briefly for ecloud's tls-keygen to provision certs at /run/tls/.
# tls-keygen is layered into the image by ecloud at deploy time and runs
# before CMD via compute-source-env.sh. Caddy serves 443 reading those certs
# and reverse-proxies to the Node app on 127.0.0.1:8080.

CERT_PATH=/run/tls/fullchain.pem
TRIES=0
while [ ! -s "$CERT_PATH" ] && [ "$TRIES" -lt 60 ]; do
  TRIES=$((TRIES + 1))
  sleep 1
done

if [ -s "$CERT_PATH" ]; then
  caddy start --config /etc/caddy/Caddyfile --adapter caddyfile
else
  echo "tls-keygen certs not present after 60s — starting node only (port 8080)"
fi

exec node dist/index.js
