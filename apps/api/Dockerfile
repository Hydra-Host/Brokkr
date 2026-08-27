# syntax=docker/dockerfile:1

# Base image with pnpm
FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
# pnpm 11 installs global bins into $PNPM_HOME/bin and refuses `add -g` unless that exact
# directory is on PATH; pnpm 8 used $PNPM_HOME itself. Both are listed so either resolves.
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
# Pin must match the workspace packageManager (package.json) and apps/bridge/Dockerfile.
RUN corepack enable && corepack install -g pnpm@11.21.0
# pnpm 11 defaults verifyDepsBeforeRun to `install`, so `pnpm exec` / `pnpm run` fire an implicit
# install mid-build that reaches the registry and prunes the layer below it. That layer is the
# authority here; a build must never re-resolve dependencies.
ENV pnpm_config_verify_deps_before_run=false

# Stage 1: Prune the monorepo for api and web workspaces
FROM base AS pruner
WORKDIR /app
# Deliberate hard pin (not a workspace-version tracker): an unpinned global turbo
# re-prunes with each upstream release, silently cold-rebuilding every layer below —
# and 2.10.x emits broken pruned lockfiles for some workspace subsets (see
# apps/bridge/Dockerfile). Bump this pin alongside the root turbo devDependency.
RUN pnpm add -g turbo@2.7.5
COPY . .
# Prune both api and web since api serves web's static files
RUN turbo prune api web --docker
# turbo 2.7.5's pruner drops peer-suffixed lockfile entries that only internal
# packages reference (vitest@…(@opentelemetry/api@…) via packages/telemetry),
# which breaks the frozen install below. Repair the pruned lockfile in place —
# resolution reuses the pruned entries, so this stays deterministic.
RUN cd out/json && pnpm install --lockfile-only --fix-lockfile

# Stage 2: Install dependencies
FROM base AS installer
WORKDIR /app

# Install OpenSSL for Prisma
# hadolint ignore=DL3008
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# First install dependencies (as they change less often)
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# Copy source code and build
COPY --from=pruner /app/out/full/ .

# Generate Prisma client and build both api and web apps
# Bump Node heap from the default ~2GB — `nest build` (tsc) OOMs on the api package otherwise.
ENV NODE_OPTIONS="--max-old-space-size=4096"
# Remote turbo cache: secrets/args are optional — absent (local builds, cache-env
# failure) the guard no-ops and the build runs uncached.
ARG TURBO_API
ARG TURBO_TEAM
RUN --mount=type=secret,id=turbo_token --mount=type=secret,id=turbo_sig --mount=type=secret,id=ci_ca_bundle \
    if [ -n "$TURBO_API" ] && [ -s /run/secrets/turbo_token ]; then \
      TURBO_TOKEN="$(cat /run/secrets/turbo_token)" && \
      TURBO_REMOTE_CACHE_SIGNATURE_KEY="$(cat /run/secrets/turbo_sig)" && \
      export TURBO_TOKEN TURBO_REMOTE_CACHE_SIGNATURE_KEY && \
      export SSL_CERT_FILE=/run/secrets/ci_ca_bundle && \
      export NODE_EXTRA_CA_CERTS=/run/secrets/ci_ca_bundle; \
    fi && \
    pnpm --filter @repo/database db:generate && \
    pnpm turbo run build --filter=api --filter=web

# Rewrite workspace exports from dev src/*.ts to built dist — before the deploy
# stage and runner copies so both inherit the corrected manifests.
RUN node -e "const fs=require('fs'); const targets=['./packages/database/package.json','./packages/auth/package.json','./packages/utils/package.json','./packages/active-record/package.json','./packages/crypto/package.json','./packages/lifecycle/package.json','./packages/telemetry/package.json']; for (const p of targets){const pkg=JSON.parse(fs.readFileSync(p,'utf8')); pkg.main='./dist/index.js'; pkg.types='./dist/index.d.ts'; if(pkg.exports && pkg.exports['.']){pkg.exports['.'].import='./dist/index.js'; pkg.exports['.'].require='./dist/index.js'; pkg.exports['.'].types='./dist/index.d.ts';} fs.writeFileSync(p, JSON.stringify(pkg, null, 2)+'\n');}"

# `pnpm deploy --prod` materializes apps/api + its full workspace dep graph into
# /api-deploy, so new api deps land in the image automatically (a missed COPY once
# shipped a boot-crashing image: MODULE_NOT_FOUND @repo/telemetry). injectWorkspacePackages picks
# the lockfile-driven deploy; --legacy re-resolved every range from the registry instead.
RUN pnpm --config.trustLockfile=true --filter=api deploy --prod /api-deploy && \
    test -f /api-deploy/dist/main.js && \
    test -d /api-deploy/node_modules/@repo/database/generated && \
    node -e "['@repo/lifecycle','@repo/telemetry','@repo/database','@repo/auth','@repo/active-record','@repo/crypto','@repo/utils','@repo/api-client','@hydrahost/plugins-config'].forEach(m=>{const r=require.resolve(m,{paths:['/api-deploy']}); if(!r.endsWith('.js')) throw new Error(m+' resolves to non-JS: '+r);})"

# Stage 4: Production runner
FROM base AS runner
WORKDIR /app

# Install OpenSSL for Prisma runtime
# hadolint ignore=DL3008
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Don't run as root
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestjs

# Copy entrypoint that generates runtime env-config.js for the SPA
COPY --chmod=755 apps/api/docker-entrypoint.sh /app/docker-entrypoint.sh

USER nestjs

# The api and its full workspace-dependency forest, self-contained (see the deploy above).
COPY --from=installer --chown=nestjs:nodejs /api-deploy ./apps/api
COPY --from=installer --chown=nestjs:nodejs /app/apps/web/dist ./apps/web/dist

# Copy workspace packages
COPY --from=installer --chown=nestjs:nodejs /app/packages/api-client/dist ./packages/api-client/dist
COPY --from=installer --chown=nestjs:nodejs /app/packages/api-client/package.json ./packages/api-client/package.json
COPY --from=installer --chown=nestjs:nodejs /app/packages/database/dist ./packages/database/dist
COPY --from=installer --chown=nestjs:nodejs /app/packages/database/package.json ./packages/database/package.json
COPY --from=installer --chown=nestjs:nodejs /app/packages/auth/dist ./packages/auth/dist
COPY --from=installer --chown=nestjs:nodejs /app/packages/auth/package.json ./packages/auth/package.json
COPY --from=installer --chown=nestjs:nodejs /app/packages/utils/dist ./packages/utils/dist
COPY --from=installer --chown=nestjs:nodejs /app/packages/utils/package.json ./packages/utils/package.json
COPY --from=installer --chown=nestjs:nodejs /app/packages/active-record/dist ./packages/active-record/dist
COPY --from=installer --chown=nestjs:nodejs /app/packages/active-record/package.json ./packages/active-record/package.json
COPY --from=installer --chown=nestjs:nodejs /app/packages/crypto/dist ./packages/crypto/dist
COPY --from=installer --chown=nestjs:nodejs /app/packages/crypto/package.json ./packages/crypto/package.json
COPY --from=installer --chown=nestjs:nodejs /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
COPY --from=installer --chown=nestjs:nodejs /app/packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY --from=installer --chown=nestjs:nodejs /app/packages/plugin-runtime/dist ./packages/plugin-runtime/dist
COPY --from=installer --chown=nestjs:nodejs /app/packages/plugin-runtime/package.json ./packages/plugin-runtime/package.json
COPY --from=installer --chown=nestjs:nodejs /app/packages/plugins-config/dist ./packages/plugins-config/dist
COPY --from=installer --chown=nestjs:nodejs /app/packages/plugins-config/package.json ./packages/plugins-config/package.json
# Plugin packages — whole-dir copy (dist + package.json + node_modules) so the set adapts to the
# tree rather than naming each plugin: the public BOSS image gets only the open-source plugins
# present in the tree; the internal image additionally gets the managed plugins (analytics,
# helpdesk-pylon) that `turbo prune` pulls in as optionalDependencies. Naming managed plugins in
# explicit COPY lines would break the public build, where those paths don't exist.
COPY --from=installer --chown=nestjs:nodejs /app/packages/plugins ./packages/plugins

# Hoisted node_modules for the plugins under /app/packages and the entrypoint's
# prisma CLI — the api itself resolves everything inside its ./apps/api tree.
COPY --from=installer --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=installer --chown=nestjs:nodejs /app/packages/api-client/node_modules ./packages/api-client/node_modules
COPY --from=installer --chown=nestjs:nodejs /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=installer --chown=nestjs:nodejs /app/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=installer --chown=nestjs:nodejs /app/packages/utils/node_modules ./packages/utils/node_modules
COPY --from=installer --chown=nestjs:nodejs /app/packages/active-record/node_modules ./packages/active-record/node_modules
COPY --from=installer --chown=nestjs:nodejs /app/packages/crypto/node_modules ./packages/crypto/node_modules
COPY --from=installer --chown=nestjs:nodejs /app/packages/plugin-sdk/node_modules ./packages/plugin-sdk/node_modules
COPY --from=installer --chown=nestjs:nodejs /app/packages/plugin-runtime/node_modules ./packages/plugin-runtime/node_modules
# pnpm strict mode: workspace packages have their deps symlinked inside
# their own node_modules, NOT hoisted to root /app/node_modules. Each
# workspace package whose dist code does `import '@hydrahost/...'` needs
# its node_modules copied so Node's resolution can follow the symlink to
# the dep's dist (which we copied above). Without these, Node ESM fails
# with `Cannot find package '@hydrahost/plugin-sdk'` at boot. (Plugin
# packages' node_modules come in via the whole-dir `packages/plugins` copy above.)
COPY --from=installer --chown=nestjs:nodejs /app/packages/plugins-config/node_modules ./packages/plugins-config/node_modules

# Copy Prisma generated client
COPY --from=installer --chown=nestjs:nodejs /app/packages/database/generated ./packages/database/generated

# Ship the schema + migrations + prisma config so the entrypoint can run
# `prisma migrate deploy` on start (see docker-entrypoint.sh). prisma.config.ts
# resolves the schema folder and the DATABASE_URL datasource at runtime.
COPY --from=installer --chown=nestjs:nodejs /app/packages/database/prisma ./packages/database/prisma
COPY --from=installer --chown=nestjs:nodejs /app/packages/database/prisma.config.ts ./packages/database/prisma.config.ts

# Ship license/attribution files in the runtime image (turbo prune drops root files).
COPY --from=pruner --chown=nestjs:nodejs /app/LICENSE /app/NOTICE /app/THIRD-PARTY-LICENSES.md ./

WORKDIR /app/apps/api

ENV NODE_ENV=production

# Public SPA config — injected at runtime by docker-entrypoint.sh into env-config.js.
ENV STRIPE_PUBLISHABLE_KEY=""
ENV RADAR_PUBLISHABLE_KEY=""
# Docs site URL override; empty falls back to the SPA default (https://brokkr.hydrahost.com/).
ENV BROKKR_DOCS_URL=""

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
