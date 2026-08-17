import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTemplateEnvironment, renderTemplateKeepTrailingNewline } from '../brokkr-discovery-initrd.service.js';
import { getInitrdConfig, resetInitrdConfigForTests } from '../initrd.config.js';

resetInitrdConfigForTests();
const ASSETS = resolve(getInitrdConfig().assetsDir, 'initrd');

async function render(relPath: string, vars: Record<string, unknown>): Promise<string> {
  const source = await readFile(resolve(ASSETS, relPath), 'utf-8');
  return renderTemplateKeepTrailingNewline(createTemplateEnvironment(), source, vars);
}

describe('brokkr-discovery templates', () => {
  it('renders agent.yaml with bridges and bearer token', async () => {
    const out = await render('brokkr-discovery/brokkr/opt/brokkr/agent.yaml.njk', {
      device_id: 'dev-1',
      zone_id: 'zone-1',
      bridges: ['bridge-zone-0:443', 'bridge-zone-1:443'],
      insecure: false,
      agent_token: 'brk_agent_tok',
      log_level: 'info',
    });

    expect(out).toContain('device_id: "dev-1"');
    expect(out).toContain('zone_id: "zone-1"');
    expect(out).toContain('insecure: false');
    expect(out).toContain('  - address: "bridge-zone-0:443"');
    expect(out).toContain('  - address: "bridge-zone-1:443"');
    expect(out).not.toContain('grpc_address:');
    expect(out).toContain('token: "brk_agent_tok"');
    expect(out).toContain('log_level: info');
  });

  it('sets insecure: true and emits no grpc_address without a dialback override', async () => {
    const out = await render('brokkr-discovery/brokkr/opt/brokkr/agent.yaml.njk', {
      device_id: 'dev-1',
      zone_id: 'zone-1',
      bridges: ['bridge-zone-0:9082'],
      insecure: true,
      agent_token: 't',
    });

    expect(out).toContain('insecure: true');
    expect(out).toContain('  - address: "bridge-zone-0:9082"');
    expect(out).not.toContain('grpc_address:');
    expect(out).toContain('log_level: info');
    expect(out).toContain('collection_snapshot_path: /var/lib/brokkr/collections');
  });

  it('unset grpc_dialback_host renders byte-identical to explicit-undefined and emits no grpc_address', async () => {
    const baseline = await render('brokkr-discovery/brokkr/opt/brokkr/agent.yaml.njk', {
      device_id: 'dev-1',
      zone_id: 'zone-1',
      bridges: ['bridge-zone-0:9082', 'bridge-zone-1:9083'],
      insecure: true,
      agent_token: 't',
    });
    const explicitUndefined = await render('brokkr-discovery/brokkr/opt/brokkr/agent.yaml.njk', {
      device_id: 'dev-1',
      zone_id: 'zone-1',
      bridges: ['bridge-zone-0:9082', 'bridge-zone-1:9083'],
      insecure: true,
      agent_token: 't',
      grpc_dialback_host: undefined,
    });
    expect(explicitUndefined).toBe(baseline);
    expect(baseline).toContain('insecure: true');
    expect(baseline).not.toContain('grpc_address:');
  });

  it('set grpc_dialback_host emits a grpc_address override preserving each entry gRPC port', async () => {
    const out = await render('brokkr-discovery/brokkr/opt/brokkr/agent.yaml.njk', {
      device_id: 'dev-1',
      zone_id: 'zone-1',
      bridges: ['bridge-zone-0:9082', 'bridge-zone-1:9083'],
      insecure: true,
      agent_token: 't',
      grpc_dialback_host: '192.168.1.50',
    });
    expect(out).toContain('grpc_address: "http://192.168.1.50:9082"');
    expect(out).toContain('grpc_address: "http://192.168.1.50:9083"');
    expect(out).toContain('  - address: "bridge-zone-0:9082"');
    expect(out).toContain('  - address: "bridge-zone-1:9083"');
  });

  it('renders the hosts file with bridge ip, hostname, and registry entries', async () => {
    const out = await render('brokkr-discovery/brokkr/etc/hosts.njk', {
      device_id: 'dev-1',
      bridge_ip: '10.0.0.2',
      bridge_hostname: 'bridge-zone-0',
      bridge_hosts: [
        { ip: '10.0.0.2', hostname: 'bridge-zone-0' },
        { ip: '10.0.0.3', hostname: 'bridge-zone-1' },
      ],
    });

    expect(out).toContain('127.0.1.1\t    host-dev-1');
    expect(out).toContain('10.0.0.2\t    bridge-zone-0 brokkr.lan');
    expect(out).toContain('10.0.0.3\t    bridge-zone-1');
  });

  it('renders authorized_keys from pubkeys', async () => {
    const out = await render('brokkr-discovery/brokkr/root/.ssh/authorized_keys.njk', {
      pubkeys: ['ssh-ed25519 AAAA a', 'ssh-rsa BBBB b'],
    });
    expect(out).toContain('ssh-ed25519 AAAA a');
    expect(out).toContain('ssh-rsa BBBB b');
  });
});

describe('ubuntu-rescue-os templates', () => {
  it('bakes the bearer header into the phone-home script', async () => {
    const out = await render('ubuntu-rescue-os/brokkr/usr/local/bin/phone-home.njk', {
      brokkr_live_token: 'test-live-token',
      phone_home_endpoint: 'https://hub/api/v1/bmc/phone-home/dev-1',
    });

    expect(out).toContain('Authorization: Bearer test-live-token');
    expect(out).toContain('"https://hub/api/v1/bmc/phone-home/dev-1"');
    expect(out.startsWith('#!/bin/bash')).toBe(true);
  });

  it('renders the rescue hostname and netplan passthrough', async () => {
    expect(await render('ubuntu-rescue-os/brokkr/etc/hostname.njk', { device_id: 'dev-7' })).toBe('rescue-dev-7');
    expect(await render('ubuntu-rescue-os/brokkr/etc/netplan/zz-brokkr.yaml.njk', { netplan: 'network: {}\n' })).toBe(
      'network: {}\n',
    );
  });
});
