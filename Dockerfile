FROM node:22-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gnupg ca-certificates debian-keyring debian-archive-keyring apt-transport-https \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends caddy \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY Caddyfile /etc/caddy/Caddyfile
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

EXPOSE 80 443 8080
CMD ["/usr/local/bin/docker-entrypoint.sh"]
