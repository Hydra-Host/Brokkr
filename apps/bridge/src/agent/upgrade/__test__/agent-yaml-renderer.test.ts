import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetInitrdConfigForTests } from '../../../initrd/initrd.config';
import { renderAgentYaml } from '../agent-yaml-renderer';

const TEMPLATE_HEADER =
  '# Rendered by ``AgentBootstrapService.ensure_agent_deployed`` and installed\n' +
  '# at ``/opt/brokkr/agent.yaml`` on the device. Today that install happens\n' +
  '# over SSH — a transitional bootstrap mechanism for devices that came up\n' +
  '# without the agent baked into their initrd. Once every device ships with\n' +
  '# the agent + config in the brokkr-live initrd, this template will be\n' +
  '# rendered at image-build time and the SSH path will go away. The schema\n' +
  '# below is the Zod-validated ``AgentConfig`` in ``apps/live-agent/src/config.ts`` —\n' +
  '# keep fields in sync regardless of which channel delivers the file.\n';

const INSECURE_COMMENT =
  '# Dial bridges over plaintext h2c instead of TLS. Rendered true when the bridge\n' +
  '# runs without a TLS front (GRPC_INSECURE or local sim). `address` carries only\n' +
  '# host:port; the agent derives http:// vs https:// from this flag.\n';

function insecureBlock(value: boolean): string {
  return INSECURE_COMMENT + `insecure: ${value}\n`;
}

const BRIDGES_COMMENT =
  '# One entry per bridge the agent should attach to. Rendered from the\n' +
  '# Redis service registry — bare hostname matches the per-bridge cert CN\n' +
  '# and the /etc/hosts block written during bootstrap. grpc_address is emitted\n' +
  '# only when a dialback host is set — a genuine host-rewrite override.\n';

const AUTH_BLOCK =
  'auth:\n' +
  '  # Per-device bearer token the agent attaches to every gRPC call as\n' +
  '  # ``authorization: Bearer <token>``.  For real device_ids this is a\n' +
  '  # long-lived device-scoped token; for the nil-UUID device (discovery\n' +
  '  # phase) it is a per-MAC 24h-TTL discovery token, minted until the device\n' +
  '  # is commissioned and its per-device initrd rebuilds.\n' +
  '  token: "tok-abc"\n';

const TLS_BLOCK =
  'tls:\n' +
  '  # Point at the system CA bundle. The brokkr-live ISO bakes the\n' +
  '  # Hydra/Brokkr CAs into /usr/local/share/ca-certificates/ and runs\n' +
  '  # update-ca-certificates at image-build time, so /etc/ssl/certs/\n' +
  '  # ca-certificates.crt has Mozilla + Hydra CAs — sufficient for the\n' +
  "  # bridge's mTLS cert and any public HTTPS the agent makes (phone-home).\n" +
  '  # Per-device agent auth is the bearer token above, not a client cert.\n' +
  '  #\n' +
  '  # We point at the file explicitly rather than relying on\n' +
  '  # NODE_EXTRA_CA_CERTS in the systemd unit: config-in-config-file is\n' +
  '  # cleaner and the bridge can vary the path per fleet via this render.\n' +
  '  ca_bundle_path: /etc/ssl/certs/ca-certificates.crt\n' +
  '  reject_unauthorized: true\n';

const PHONE_HOME_COMMENT =
  '# No phone_home block: the brokkr-live agent phones home over its gRPC\n' +
  "# session (AgentService.PhoneHome), authenticated by the session's bearer\n" +
  '# token — no encrypted cipher/signature baked into the initrd. The bridge\n' +
  '# forwards it to the hub. (The deployed OS phones home via a cloud-init shell\n' +
  '# script, which still carries its own token from the provisioning payload.)\n';

function agentBlock(logLevel: string): string {
  return (
    'agent:\n' +
    '  heartbeat_interval_ms: 30000\n' +
    '  heartbeat_timeout_ms: 90000\n' +
    '  reconnect_backoff_initial_ms: 1000\n' +
    '  reconnect_backoff_max_ms: 60000\n' +
    '  work_timeout_default_ms: 300000\n' +
    `  log_level: ${logLevel}\n` +
    '  collection_snapshot_path: /var/lib/brokkr/collections\n'
  );
}

const TELEMETRY_BLOCK =
  'telemetry:\n' +
  '  # Rendered true only by bridges whose own OTLP telemetry is enabled — the\n' +
  '  # agent ships spans through AgentService.ReportTraces (bridge relays them);\n' +
  '  # it never needs collector reachability or OTLP credentials.\n' +
  '  traces_enabled: false\n';

const EXPECTED_INSECURE =
  TEMPLATE_HEADER +
  '\ndevice_id: "11111111-1111-1111-1111-111111111111"\n' +
  '\nzone_id: "zone-1"\n\n' +
  insecureBlock(true) +
  '\n' +
  BRIDGES_COMMENT +
  'bridges:\n' +
  '  - address: "bridge-a.example:443"\n' +
  '  - address: "bridge-b.example:443"\n\n' +
  AUTH_BLOCK +
  '\n' +
  TLS_BLOCK +
  '\n' +
  agentBlock('info') +
  '\n' +
  TELEMETRY_BLOCK +
  '\n' +
  PHONE_HOME_COMMENT;

const EXPECTED_TLS =
  TEMPLATE_HEADER +
  '\ndevice_id: "00000000-0000-0000-0000-000000000000"\n' +
  '\nzone_id: "zone-1"\n\n' +
  insecureBlock(false) +
  '\n' +
  BRIDGES_COMMENT +
  'bridges:\n' +
  '  - address: "bridge-a.example:443"\n\n' +
  AUTH_BLOCK +
  '\n' +
  TLS_BLOCK +
  '\n' +
  agentBlock('debug') +
  '\n' +
  TELEMETRY_BLOCK +
  '\n' +
  PHONE_HOME_COMMENT;

const SAVED_KEYS = [
  'BROKKR_ZONE_ID',
  'LOG_LEVEL',
  'GRPC_INSECURE',
  'LOCAL_SIMULATION_ENABLED',
  'BRIDGE_GRPC_DIALBACK_HOST',
  'ENVIRONMENT',
] as const;

describe('renderAgentYaml', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SAVED_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env['BROKKR_ZONE_ID'] = 'zone-1';
    resetInitrdConfigForTests();
  });

  afterEach(() => {
    for (const key of SAVED_KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetInitrdConfigForTests();
  });

  it('matches the nunjucks render for an insecure (plaintext) device', async () => {
    process.env['LOG_LEVEL'] = 'info';
    process.env['GRPC_INSECURE'] = 'true';
    resetInitrdConfigForTests();

    const out = await renderAgentYaml({
      deviceId: '11111111-1111-1111-1111-111111111111',
      bridges: ['bridge-a.example:443', 'bridge-b.example:443'],
      agentToken: 'tok-abc',
      jobId: 'job-x',
    });

    expect(out).toBe(EXPECTED_INSECURE);
  });

  it('matches the nunjucks render with TLS (no GRPC_INSECURE)', async () => {
    process.env['LOG_LEVEL'] = 'debug';
    resetInitrdConfigForTests();

    const out = await renderAgentYaml({
      deviceId: '00000000-0000-0000-0000-000000000000',
      bridges: ['bridge-a.example:443'],
      agentToken: 'tok-abc',
      jobId: 'job-x',
    });

    expect(out).toBe(EXPECTED_TLS);
  });

  it('renders insecure: false and no grpc_address when GRPC_INSECURE=false', async () => {
    process.env['LOG_LEVEL'] = 'info';
    process.env['GRPC_INSECURE'] = 'false';
    resetInitrdConfigForTests();

    const out = await renderAgentYaml({
      deviceId: 'dev-1',
      bridges: ['bridge-a.example:443'],
      agentToken: 'tok-abc',
      jobId: 'job-x',
    });

    expect(out).toContain('insecure: false');
    expect(out).not.toContain('grpc_address:');
  });

  it('renders insecure: true and no grpc_address when LOCAL_SIMULATION_ENABLED=true (no dialback)', async () => {
    process.env['LOG_LEVEL'] = 'info';
    process.env['LOCAL_SIMULATION_ENABLED'] = 'true';
    resetInitrdConfigForTests();

    const out = await renderAgentYaml({
      deviceId: 'dev-1',
      bridges: ['bridge-a.example:443'],
      agentToken: 'tok-abc',
      jobId: 'job-x',
    });

    expect(out).toContain('insecure: true');
    expect(out).not.toContain('grpc_address:');
  });
});
