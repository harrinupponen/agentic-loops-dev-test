# syntax=docker/dockerfile:1

# Sevalla rebuilds this Dockerfile itself, so CI and Sevalla produce two
# separate images. Pin the base by digest (docker buildx imagetools inspect
# node:22-bookworm-slim) to keep them byte-equivalent.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The base tag is floating, not pinned by digest despite the comment above —
# each build can land on a Debian snapshot where a specific OS package has a
# fix available upstream but not yet baked into that snapshot. Upgrade only
# the flagged package(s) rather than `apt-get upgrade -y`: a blanket upgrade
# pulled in a much newer package set and made the scan far worse (2 HIGH/0
# CRITICAL -> 52 HIGH/4 CRITICAL, including an unfixed CRITICAL in zlib1g) —
# verified locally with `trivy image` before settling on this narrower fix.
RUN apt-get update && apt-get install -y --only-upgrade libpcre2-8-0 && rm -rf /var/lib/apt/lists/*
RUN groupadd -r app && useradd -r -g app app
# The entrypoint below only ever calls `node`, never npm/npx — but the base
# image ships them anyway, and their own bundled dependencies (not ours) are
# what the image scan actually flags. Strip them so there's nothing there to
# have a CVE in.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
COPY scripts/docker-entrypoint.sh ./
USER app
EXPOSE 3000
# The entrypoint migrates, then execs the server so Node receives SIGTERM
# directly (see src/index.ts for graceful shutdown).
ENTRYPOINT ["./docker-entrypoint.sh"]
