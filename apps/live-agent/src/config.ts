import { load as parseYaml } from 'js-yaml';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { z } from 'zod';

export const AgentConfig = z.object({
  device_id: z.string().describe('Stable device identifier the agent registers with each bridge.'),
  zone_id: z.string().describe("The hub's Zone.id (UUID) the agent belongs to."),

  insecure: z
    .boolean()
    .default(false)
    .describe(
      'Dial bridges over plaintext h2c (http://) instead of TLS (https://). The bridge renders this true ' +
        'when it runs without a TLS front (GRPC_INSECURE or local sim). Per-bridge `grpc_address` still wins.',
    ),

  bridges: z
    .array(
      z.object({
        address: z.string().describe("Bridge host:port, e.g. 'bridge-1-76-14-956:9082'."),
        grpc_address: z
          .string()
          .optional()
          .describe(
            "Rare explicit override URL passed verbatim to connect-node, e.g. 'https://vip.example:443'. " +
              'When omitted, the dial URL is derived from `address` and the top-level `insecure` flag.',
          ),
      }),
    )
    .min(1, 'at least one bridge must be configured')
    .describe('Bootstrap set of bridges; the first successful registration returns the full topology.'),

  auth: z
    .object({
      token: z
        .string()
        .min(1)
        .describe(
          'Per-device bearer token attached as `authorization: Bearer` on every gRPC call. Rendered into this YAML by the bridge at initrd-build or SSH-bootstrap time.',
        ),
    })
    .describe('Per-device bearer token auth material.'),

  tls: z
    .object({
      ca_bundle_path: z
        .string()
        .optional()
        .describe(
          'Explicit CA bundle path. Leave unset to trust the system CA store ' +
            '(/etc/ssl/certs/ca-certificates.crt), which the brokkr-live ISO populates with ' +
            'the Hydra/Brokkr CAs at image-build time. Set explicitly only when the system ' +
            'store is unavailable or you want to pin a narrower bundle.',
        ),
      reject_unauthorized: z
        .boolean()
        .default(true)
        .describe(
          "Node's TLS strictness toggle for verifying the bridge's server cert. Opt out in dev / fixture runs only.",
        ),
    })
    .default({})
    .describe('Server-cert verification toggle + optional explicit CA bundle path.'),

  agent: z
    .object({
      heartbeat_interval_ms: z
        .number()
        .int()
        .positive()
        .default(30_000)
        .describe('How often the agent sends a heartbeat envelope (ms).'),
      heartbeat_timeout_ms: z
        .number()
        .int()
        .positive()
        .default(90_000)
        .describe('Silence window before the watchdog closes the socket and triggers reconnect (ms).'),
      reconnect_backoff_initial_ms: z
        .number()
        .int()
        .min(250)
        .default(1_000)
        .describe(
          'First reconnect delay (ms); doubles per attempt until capped at max. Minimum 250ms keeps the lower edge of full-jitter sensible — N agents restarting simultaneously distribute across [0, initial_ms), so a too-small base produces a thundering herd.',
        ),
      reconnect_backoff_max_ms: z
        .number()
        .int()
        .positive()
        .default(60_000)
        .describe('Maximum reconnect delay (ms) after exponential growth.'),
      work_timeout_default_ms: z
        .number()
        .int()
        .positive()
        .default(300_000)
        .describe('Per-dispatch timeout applied when the bridge omits timeout_ms (ms).'),
      max_concurrent_dispatches: z
        .number()
        .int()
        .positive()
        .default(96)
        .describe(
          'Ceiling on concurrent dispatches; excess work is rejected THROTTLED so a bridge cannot flood the agent.',
        ),
      token_renew_interval_ms: z
        .number()
        .int()
        .positive()
        .default(3_600_000)
        .describe(
          'How often the agent calls RenewToken on an active bridge session to slide its bearer-token TTL forward (ms). Must be shorter than the server-side AGENT_AUTH_DEVICE_TTL_S (default 24h) with meaningful safety margin — default 1h gives a 24× ratio.',
        ),
      log_level: z
        .enum(['trace', 'debug', 'info', 'warn', 'error'])
        .default('info')
        .describe(
          'Minimum level written to the structured JSON logger. ``trace`` is the home for subprocess streaming output ' +
            '(lspci / dmidecode / etc.) and is filtered out by default; flip to ``trace`` only when debugging a ' +
            'specific tool. ``AGENT_LOG_LEVEL`` env var on the agent process overrides this.',
        ),
      collection_snapshot_path: z
        .string()
        .default('/var/lib/brokkr/collections')
        .describe(
          'Directory where collection.collectAll writes per-collector JSON snapshots. The agent creates the ' +
            'directory with mode 0o700 on first write; each snapshot is owner-read-write only. ' +
            'Best-effort: write failures log a warning and do not fail the collector.',
        ),
    })
    .default({})
    .describe('Connection + heartbeat + logging knobs.'),

  telemetry: z
    .object({
      traces_enabled: z
        .boolean()
        .default(false)
        .describe(
          'Ship agent operation spans to bridges via AgentService.ReportTraces (the bridge relays them ' +
            'to its own OTLP endpoint). Rendered true by bridges whose own telemetry is enabled; the ' +
            'agent never talks to a collector directly.',
        ),
    })
    .default({})
    .describe('OpenTelemetry knobs. Traces leave the device only through the bridge relay.'),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export function loadConfig(path: string): AgentConfig {
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw);
  const config = AgentConfig.parse(parsed);
  assertServerTrustMaterialReadable(config);
  return config;
}

function assertServerTrustMaterialReadable(config: AgentConfig): void {
  if (!config.tls.reject_unauthorized) return;
  if (!config.tls.ca_bundle_path) return;

  try {
    accessSync(config.tls.ca_bundle_path, fsConstants.R_OK);
  } catch {
    throw new Error(
      `Bridge TLS CA bundle unreadable (set tls.reject_unauthorized=false to opt out): ca_bundle_path=${config.tls.ca_bundle_path}`,
    );
  }
}
