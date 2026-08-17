import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentConfig, loadConfig } from '../config';

const PHONE_HOME_YAML = `phone_home:
  deployment_os_token: brk_dev_os_test
  endpoint: https://hub.test/api/v1/bmc/phone-home`;

const PHONE_HOME_OBJ = {
  deployment_os_token: 'brk_dev_os_test',
  endpoint: 'https://hub.test/api/v1/bmc/phone-home',
};

function writeYaml(dir: string, contents: string): string {
  const path = join(dir, 'agent.yaml');
  writeFileSync(path, contents);
  return path;
}

describe('loadConfig CA-bundle readability guard', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-config-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts the config when reject_unauthorized=true and the CA bundle exists', () => {
    const caPath = join(dir, 'ca.crt');
    writeFileSync(caPath, '---CA---');

    const configPath = writeYaml(
      dir,
      `
device_id: dev-1
zone_id: "00000000-0000-4000-8000-000000000001"
bridges:
  - address: bridge.test:443
auth:
  token: test-token
tls:
  ca_bundle_path: ${caPath}
  reject_unauthorized: true
${PHONE_HOME_YAML}
`.trim(),
    );

    expect(() => loadConfig(configPath)).not.toThrow();
  });

  it('throws when reject_unauthorized=true and the CA bundle is missing', () => {
    const configPath = writeYaml(
      dir,
      `
device_id: dev-1
zone_id: "00000000-0000-4000-8000-000000000001"
bridges:
  - address: bridge.test:443
auth:
  token: test-token
tls:
  ca_bundle_path: /definitely/not/here/ca.crt
  reject_unauthorized: true
${PHONE_HOME_YAML}
`.trim(),
    );

    expect(() => loadConfig(configPath)).toThrow(/TLS/);
    expect(() => loadConfig(configPath)).toThrow(/ca\.crt/);
  });

  it('allows a missing CA bundle when reject_unauthorized=false', () => {
    const configPath = writeYaml(
      dir,
      `
device_id: dev-1
zone_id: "00000000-0000-4000-8000-000000000001"
bridges:
  - address: bridge.test:443
auth:
  token: test-token
tls:
  ca_bundle_path: /definitely/not/here/ca.crt
  reject_unauthorized: false
${PHONE_HOME_YAML}
`.trim(),
    );

    expect(() => loadConfig(configPath)).not.toThrow();
  });

  it('allows omitting ca_bundle_path so Node uses the system trust store', () => {
    const configPath = writeYaml(
      dir,
      `
device_id: dev-1
zone_id: "00000000-0000-4000-8000-000000000001"
bridges:
  - address: bridge.test:443
auth:
  token: test-token
tls:
  reject_unauthorized: true
${PHONE_HOME_YAML}
`.trim(),
    );

    expect(() => loadConfig(configPath)).not.toThrow();
    const cfg = loadConfig(configPath);
    expect(cfg.tls.ca_bundle_path).toBeUndefined();
    expect(cfg.tls.reject_unauthorized).toBe(true);
  });
});

describe('auth section', () => {
  it('accepts a token string', () => {
    const parsed = AgentConfig.parse({
      device_id: 'd',
      zone_id: '00000000-0000-4000-8000-000000000001',
      bridges: [{ address: 'bridge.test:443' }],
      auth: { token: 'deadbeef' },
      phone_home: PHONE_HOME_OBJ,
    });
    expect(parsed.auth.token).toBe('deadbeef');
  });

  it('rejects missing auth section', () => {
    expect(() =>
      AgentConfig.parse({
        device_id: 'd',
        zone_id: '00000000-0000-4000-8000-000000000001',
        bridges: [{ address: 'bridge.test:443' }],
        phone_home: PHONE_HOME_OBJ,
      }),
    ).toThrow();
  });

  it('rejects empty token', () => {
    expect(() =>
      AgentConfig.parse({
        device_id: 'd',
        zone_id: '00000000-0000-4000-8000-000000000001',
        bridges: [{ address: 'bridge.test:443' }],
        auth: { token: '' },
        phone_home: PHONE_HOME_OBJ,
      }),
    ).toThrow();
  });
});

describe('telemetry section', () => {
  const BASE = {
    device_id: 'd',
    zone_id: '00000000-0000-4000-8000-000000000001',
    bridges: [{ address: 'bridge.test:443' }],
    auth: { token: 'deadbeef' },
  };

  it('defaults traces_enabled to false when the block is absent (older rendered YAML)', () => {
    const parsed = AgentConfig.parse(BASE);
    expect(parsed.telemetry.traces_enabled).toBe(false);
  });

  it('accepts an explicit traces_enabled: true', () => {
    const parsed = AgentConfig.parse({ ...BASE, telemetry: { traces_enabled: true } });
    expect(parsed.telemetry.traces_enabled).toBe(true);
  });
});
