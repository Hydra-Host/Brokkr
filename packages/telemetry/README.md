# @repo/telemetry

OpenTelemetry bootstrap shared by the Brokkr apps (hub + bridge). Off by
default: without an OTLP endpoint the SDK is never even `require`d.

## How it works

`initTelemetry({ serviceName, preset })` must run **before** the modules it
instruments are loaded. The hub does this with a side-effect import at the top
of `apps/api/src/main.ts` (`import './telemetry/init'`) — after `dotenv/config`,
before `@hydrahost/plugins-config` / `@nestjs/core`. Do not move that import;
`apps/api/src/telemetry/__test__/telemetry-import-order.spec.ts` guards it.

The `hub` preset instruments: incoming/outgoing HTTP, Express, NestJS, ioredis
(covers BullMQ's connections), pg, undici/fetch, and Prisma. Better Auth's
native spans activate automatically once a tracer provider is registered.
The `bridge` preset swaps Express/pg/Prisma for Fastify (@fastify/otel) and
gRPC. Probe paths (`/healthcheck`, `/api/health`) are not traced.

BullMQ tracing is constructor opt-in: every Queue/Worker passes
`telemetry: getBullMqTelemetry(...)` (undefined when disabled). Context rides
on `job.opts.telemetry`, never `job.data`, so payload validation on either
side is unaffected — a provisioning saga is one distributed trace across
hub enqueue → bridge worker → bridge results → hub results consumer.

## Configuration (standard OTEL env contract)

| Variable                                                           | Effect                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                      | Base OTLP endpoint (`/v1/traces` appended). Presence turns tracing on.                                             |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`                               | Per-signal endpoint, used **as-is**. Also turns tracing on.                                                        |
| `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Auth headers, `key=value` comma-separated.                                                                         |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                                      | `http/protobuf` (default) or `http/json`. `grpc` is not supported.                                                 |
| `OTEL_SERVICE_NAME`                                                | Overrides the per-app default (`brokkr-hub`).                                                                      |
| `OTEL_TRACES_SAMPLER_ARG`                                          | Sample ratio 0.0–1.0 (Sentry `tracesSampleRate` style; sampler defaults to `parentbased_traceidratio`, ratio 1.0). |
| `OTEL_SDK_DISABLED=true`                                           | Hard kill switch.                                                                                                  |
| `OTEL_TRACES_EXPORTER=console`                                     | Debug: print spans to stdout, no endpoint needed.                                                                  |

Empty-string values count as unset (secretspec's hermetic local profile
resolves absent secrets to `""`).

Metrics (phase 4) export alongside traces whenever an endpoint that can
receive them exists — the base endpoint or `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`;
an explicit `OTEL_METRICS_EXPORTER` (`otlp`/`none`) wins. A Sentry-only
deployment (per-signal traces endpoint, no base) keeps metrics off
automatically — Sentry rejects OTLP metrics. `OTEL_METRIC_EXPORT_INTERVAL`
(ms, default 60000) sets the push cadence. What's emitted: HTTP server/client
duration histograms, Node runtime metrics (event loop, GC, heap), and domain
counters (`brokkr.bridge_results.processed`, `brokkr.saga.completed`) — see
the App metrics row of the RED dashboard. Logs stay pinned off until phase 5.

### Sentry (no Sentry SDK — Sentry as an OTLP backend)

Sentry's OTLP paths are non-standard, so the per-signal variables are required
(the base endpoint would append `/v1/traces` and miss):

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://o<orgId>.ingest.sentry.io/api/<projectId>/integration/otlp/v1/traces"
OTEL_EXPORTER_OTLP_TRACES_HEADERS="x-sentry-auth=sentry sentry_key=<publicKey>"
OTEL_TRACES_SAMPLER_ARG="0.1"
```

Values come from Sentry → Project settings → Client Keys (DSN). Sentry accepts
OTLP traces and logs only — **no metrics** (point those at a
Prometheus-compatible backend when the metrics phase lands).

### Local backend under `task up` (devenv-native, recommended)

Set `telemetry.enable = true;` in `devenv.local.nix` — the stack gains an
`observability` group (OTel collector :4318 → Tempo, span-metrics → the existing
Thanos, Grafana at http://localhost:4300 with this package's dashboards
provisioned) and the hub's `OTEL_EXPORTER_OTLP_ENDPOINT` is pointed at the local
collector automatically. No docker. Ports live in `devenv/modules/ports.nix`.

### Local all-in-one backend (docker, personal workflow)

```sh
pnpm --filter @repo/telemetry lgtm:up     # grafana/otel-lgtm: Collector+Tempo+Prometheus+Loki+Grafana
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 pnpm dev
# dashboard: http://localhost:3200/d/brokkr-hub-red (admin/admin); raw traces: Explore -> Tempo
pnpm --filter @repo/telemetry lgtm:down
```

`lgtm:up` auto-imports every `dashboards/*.json` (the container is ephemeral, so
dashboards live in the repo — `lgtm:dashboards` re-pushes after edits). The
included **Brokkr Hub — Traces (RED)** dashboard is built entirely from Tempo's
span-derived metrics (`traces_spanmetrics_*`): request rate, latency quantiles,
error-spans, per-route table, recent traces, and the service graph — no
app-side metrics pipeline needed.

(Grafana remapped to 3200 — the hub owns 3000. This container is a standalone
testing harness, never wired into `task up` — use the devenv-native sink above
for stack workflows; the two cannot run at once, both claim 4317/4318.)

## Span attributes

`TelemetryModule` (hub) stamps request identity onto active spans: request id,
organization id, user id, auth type, request source, device id/token context.
**IDs only — never email or names**; spans are exported to third-party backends
across all tenants.

## Verifying

```sh
pnpm --filter @repo/telemetry build && pnpm --filter @repo/telemetry smoke
```

boots an in-process OTLP sink, initializes the hub preset, drives an Express
request, and asserts spans arrive — proving the init-before-require contract.
