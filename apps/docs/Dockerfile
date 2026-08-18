# syntax=docker/dockerfile:1

# Standalone documentation site (@repo/docs). Builds the Vite SPA and bundles the
# API reference (Redoc, generated offline from apps/api) into the same static output,
# then serves it all with a small Node static server (sirv). No nginx, no Caddy.
# TLS and routing belong at the edge, not in this image.
# Build context is the repo root (the build needs the pnpm workspace):
#   docker build -f apps/docs/Dockerfile -t brokkr-docs .

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin must match the workspace packageManager (package.json).
RUN corepack enable && corepack install -g pnpm@8.15.9

# Stage 1: prune the monorepo to @repo/docs and api. api is pulled in so the docs
# build can run api's offline OpenAPI/Redoc generator (no running hub needed).
FROM base AS pruner
WORKDIR /app
# Hard pin (see apps/api/Dockerfile): an unpinned turbo re-prunes each release and
# cold-rebuilds every layer below. Bump alongside the root turbo devDependency.
RUN pnpm add -g turbo@2.7.5
COPY . .
RUN turbo prune @repo/docs api --docker
# turbo 2.7.5's pruner can drop peer-suffixed lockfile entries; repair in place so
# the frozen install below stays deterministic (same fix as apps/api/Dockerfile).
RUN cd out/json && pnpm install --lockfile-only --fix-lockfile

# Stage 2: install deps, build the SPA, generate the Redoc reference, assemble dist.
FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# Vite bundles @repo/ui from source, so no separate package build is needed.
ENV NODE_OPTIONS="--max-old-space-size=4096"
# Build-time public config (Vite inlines import.meta.env at build). Override to point
# the "Edit on GitHub" links at your fork or mirror.
ARG VITE_DOCS_EDIT_BASE=""
ENV VITE_DOCS_EDIT_BASE=$VITE_DOCS_EDIT_BASE
# Build the docs SPA and api's workspace dependencies (api^... = api's deps, not api
# itself). The offline generator imports those packages' built dist/ and the Prisma
# client (produced by the database build), so they must exist before it runs; api's
# own nest build is not needed.
RUN pnpm turbo run build --filter=@repo/docs --filter=api^...
# Generate the public API reference offline (writes apps/api/openapi/{public.json,index.html}).
# The generator only runs its body when passed --seed-script (see the script).
RUN cd apps/api && pnpm exec tsx src/scripts/openapi/generate-openapi.ts --seed-script
# Bundle Redoc under /api so it serves at that path from the static output. The
# generated HTML inlines the spec, so no reference rewrite is needed; public.json
# is copied alongside for direct access.
RUN mkdir -p apps/docs/dist/api && \
    cp apps/api/openapi/index.html apps/docs/dist/api/index.html && \
    cp apps/api/openapi/public.json apps/docs/dist/api/public.json

# Stage 3: static runtime. Node serving the built SPA (plus /api) over plain HTTP on
# $PORT (default 8080) via sirv. --single gives SPA history fallback; real files like
# /api/index.html are still served directly. Put TLS and routing at your edge.
FROM node:24-slim AS runner
ENV PORT=8080
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g sirv-cli@3.0.1
COPY --from=builder /app/apps/docs/dist ./dist
EXPOSE 8080
CMD ["sh", "-c", "sirv dist --single --host 0.0.0.0 --port $PORT"]
