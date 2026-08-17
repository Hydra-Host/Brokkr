import { describe, expect, it } from 'vitest';

import { provisionSagaPayloadSchema } from '../provision.schema';

const OS_LAYER = {
  layer: 'base-debian-12',
  sha256: 'abc123def456',
  compression: 'zstd',
  stack_position: 0,
};

const PLATFORM = {
  slug: 'debian-12',
  codename: 'bookworm',
  os_version: '12.5',
  os_distro: 'debian',
  variant: 'server',
};

const LIFECYCLE_DATA = {
  hostname: 'srv-42.example.com',
  node_desc: 'Compute Node 42',
  disk_layouts: [{ device: '/dev/sda', partitions: [] }],
  pubkeys: ['ssh-ed25519 AAAA...'],
  user_data: { runcmd: ['echo hello'] },
  ipxe_url: null,
  os_layers: [OS_LAYER],
  server_token: {
    deployment_os_token: 'test-os-token-abc',
    endpoint: 'https://hub/api/v1/bmc/phone-home',
    exp: 1_730_000_000,
  },
};

const DEVICE_DATA = {
  netplan: null,
};

const BMC_SECRET = {
  zoneId: '00000000-0000-0000-0000-000000000001',
  zoneKeyId: '00000000-0000-0000-0000-0000000000e1',
  deviceId: 'e5f6a7b8-1234-5678-9abc-def012345678',
  purpose: 'BMC',
  kind: 'USER',
  keyGen: 1,
  ephPub: 'ZXBoUHViQmFzZTY0',
  ciphertext: 'Y2lwaGVydGV4dEJhc2U2NA==',
  tag: 'dGFnQmFzZTY0',
};

const VALID = {
  device_id: 'e5f6a7b8-1234-5678-9abc-def012345678',
  bmc_ip: '10.0.0.1',
  secrets: { bmc: BMC_SECRET },
  status: 'provisioning',
  tee_enabled: false,
  boot_device: 'pxe',
  platform: PLATFORM,
  device_data: DEVICE_DATA,
  lifecycle_data: LIFECYCLE_DATA,
};

function parse(payload: unknown) {
  return provisionSagaPayloadSchema.safeParse(payload);
}

function omit<T extends Record<string, unknown>, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

describe('provisionSagaPayloadSchema', () => {
  it('accepts the canonical valid payload', () => {
    const r = parse(VALID);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.device_id).toBe('e5f6a7b8-1234-5678-9abc-def012345678');
      expect(r.data.status).toBe('provisioning');
      expect(r.data.platform.slug).toBe('debian-12');
      expect(r.data.lifecycle_data.hostname).toBe('srv-42.example.com');
      expect(r.data.lifecycle_data.os_layers).toHaveLength(1);
      expect(r.data.lifecycle_data.os_layers?.[0].compression).toBe('zstd');
    }
  });

  it('accepts reprovisioning status', () => {
    const r = parse({ ...VALID, status: 'reprovisioning' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.status).toBe('reprovisioning');
    }
  });

  it('rejects missing required field (platform)', () => {
    expect(parse(omit(VALID, 'platform')).success).toBe(false);
  });

  it('rejects a payload missing the sealed secrets envelope', () => {
    expect(parse(omit(VALID, 'secrets')).success).toBe(false);
  });

  it('rejects plaintext root creds (username/password are no longer payload fields)', () => {
    expect(parse({ ...VALID, username: 'admin', password: 'secret' }).success).toBe(false);
  });

  it('rejects a malformed sealed secret (missing zoneKeyId)', () => {
    const { zoneKeyId: _omit, ...badBmc } = BMC_SECRET;
    expect(parse({ ...VALID, secrets: { bmc: badBmc } }).success).toBe(false);
  });

  it('rejects an unexpected sibling secret kind under secrets', () => {
    expect(parse({ ...VALID, secrets: { bmc: BMC_SECRET, console: BMC_SECRET } }).success).toBe(false);
  });

  it('rejects extra top-level field', () => {
    expect(parse({ ...VALID, rogue: 'x' }).success).toBe(false);
  });

  it('rejects extra field in platform', () => {
    expect(parse({ ...VALID, platform: { ...PLATFORM, extra_field: 'x' } }).success).toBe(false);
  });

  it('rejects extra field in os_layer entry', () => {
    const lifecycle = { ...LIFECYCLE_DATA, os_layers: [{ ...OS_LAYER, unknown: true }] };
    expect(parse({ ...VALID, lifecycle_data: lifecycle }).success).toBe(false);
  });

  it('accepts os_layers=null with ipxe_url set', () => {
    const lifecycle = {
      ...LIFECYCLE_DATA,
      os_layers: null,
      ipxe_url: 'http://boot.example.com/chain.ipxe',
    };
    const r = parse({ ...VALID, lifecycle_data: lifecycle });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lifecycle_data.os_layers).toBeNull();
      expect(r.data.lifecycle_data.ipxe_url).toBe('http://boot.example.com/chain.ipxe');
    }
  });

  it('accepts os_layers set with ipxe_url=null', () => {
    const lifecycle = { ...LIFECYCLE_DATA, os_layers: [OS_LAYER], ipxe_url: null };
    const r = parse({ ...VALID, lifecycle_data: lifecycle });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lifecycle_data.os_layers).toHaveLength(1);
      expect(r.data.lifecycle_data.ipxe_url).toBeNull();
    }
  });

  it('rejects invalid compression (lz4)', () => {
    const lifecycle = {
      ...LIFECYCLE_DATA,
      os_layers: [{ ...OS_LAYER, compression: 'lz4' }],
    };
    expect(parse({ ...VALID, lifecycle_data: lifecycle }).success).toBe(false);
  });

  it('lifecycle_data.password_hash defaults to nullish', () => {
    const r = parse(VALID);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lifecycle_data.password_hash ?? null).toBeNull();
    }
  });

  it('lifecycle_data.password_hash accepted when provided', () => {
    const lifecycle = { ...LIFECYCLE_DATA, password_hash: '$6$rounds=656000$abc$xyz' };
    const r = parse({ ...VALID, lifecycle_data: lifecycle });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lifecycle_data.password_hash).toBe('$6$rounds=656000$abc$xyz');
    }
  });

  it('rejects invalid status (deprovisioning)', () => {
    expect(parse({ ...VALID, status: 'deprovisioning' }).success).toBe(false);
  });

  it('server_token nullish on ipxe path', () => {
    const lifecycle = {
      ...omit(LIFECYCLE_DATA, 'server_token'),
      os_layers: null,
      ipxe_url: 'http://boot.example.com/chain.ipxe',
    };
    const r = parse({ ...VALID, lifecycle_data: lifecycle });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lifecycle_data.server_token ?? null).toBeNull();
    }
  });

  it('server_token accepted when provided', () => {
    const lifecycle = {
      ...LIFECYCLE_DATA,
      server_token: {
        deployment_os_token: 'test-os-token-xyz',
        endpoint: 'https://hub/api/v1/bmc/phone-home',
        exp: 1_730_000_001,
      },
    };
    const r = parse({ ...VALID, lifecycle_data: lifecycle });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lifecycle_data.server_token).not.toBeNull();
      expect(r.data.lifecycle_data.server_token?.deployment_os_token).toBe('test-os-token-xyz');
      expect(r.data.lifecycle_data.server_token?.endpoint).toBe('https://hub/api/v1/bmc/phone-home');
    }
  });

  it('server_token required on OS-deploy path', () => {
    expect(parse({ ...VALID, lifecycle_data: omit(LIFECYCLE_DATA, 'server_token') }).success).toBe(false);
  });

  it('server_token optional when ipxe_url set', () => {
    const lifecycle = {
      ...omit(LIFECYCLE_DATA, 'server_token'),
      os_layers: null,
      ipxe_url: 'http://boot.example.com/chain.ipxe',
    };
    const r = parse({ ...VALID, lifecycle_data: lifecycle });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lifecycle_data.ipxe_url).toBe('http://boot.example.com/chain.ipxe');
      expect(r.data.lifecycle_data.server_token ?? null).toBeNull();
    }
  });

  it('rejects server_token with empty token', () => {
    const lifecycle = {
      ...LIFECYCLE_DATA,
      server_token: { deployment_os_token: '', endpoint: 'https://hub/api/v1/bmc/phone-home', exp: 1 },
    };
    expect(parse({ ...VALID, lifecycle_data: lifecycle }).success).toBe(false);
  });

  it('rejects extra fields in server_token', () => {
    const lifecycle = {
      ...LIFECYCLE_DATA,
      server_token: {
        deployment_os_token: 'test-os-token-abc',
        endpoint: 'https://hub/api/v1/bmc/phone-home',
        exp: 1,
        extra: 'nope',
      },
    };
    expect(parse({ ...VALID, lifecycle_data: lifecycle }).success).toBe(false);
  });

  it('accepts device_data with netplan string', () => {
    const r = parse({ ...VALID, device_data: { netplan: 'network:\n  version: 2\n' } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.device_data.netplan).toBe('network:\n  version: 2\n');
    }
  });

  it('device_data.netplan defaults to nullish', () => {
    const r = parse(VALID);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.device_data.netplan ?? null).toBeNull();
    }
  });

  it('device_data ignores extra fields', () => {
    const r = parse({ ...VALID, device_data: { netplan: null, rogue: 'x' } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.device_data.netplan ?? null).toBeNull();
      expect((r.data.device_data as Record<string, unknown>).rogue).toBeUndefined();
    }
  });

  it('rejects payload missing device_data', () => {
    expect(parse(omit(VALID, 'device_data')).success).toBe(false);
  });

  it('device_data fields default to nullish or false', () => {
    const r = parse(VALID);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.device_data.netplan ?? null).toBeNull();
      expect(r.data.device_data.gpu_model ?? null).toBeNull();
      expect(r.data.device_data.purge_ttys).toBe(false);
      expect(r.data.device_data.serial_port ?? null).toBeNull();
      expect(r.data.device_data.device_type ?? null).toBeNull();
      expect(r.data.device_data.network_type ?? null).toBeNull();
    }
  });

  it('device_data accepts all new fields', () => {
    const r = parse({
      ...VALID,
      device_data: {
        netplan: 'network: {}\n',
        gpu_model: 'NVIDIA H100',
        purge_ttys: true,
        serial_port: 'ttyS1',
        device_type: 'poweredge-xe9780',
        network_type: 'roce',
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.device_data.gpu_model).toBe('NVIDIA H100');
      expect(r.data.device_data.purge_ttys).toBe(true);
      expect(r.data.device_data.serial_port).toBe('ttyS1');
      expect(r.data.device_data.device_type).toBe('poweredge-xe9780');
      expect(r.data.device_data.network_type).toBe('roce');
    }
  });

  it('rejects device_data.purge_ttys with non-bool', () => {
    expect(parse({ ...VALID, device_data: { purge_ttys: { x: 1 } } }).success).toBe(false);
  });

  it('rejects device_data.gpu_model with non-string', () => {
    expect(parse({ ...VALID, device_data: { gpu_model: ['NVIDIA'] } }).success).toBe(false);
  });

  it('tee_requested defaults to false', () => {
    const r = parse(VALID);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tee_requested).toBe(false);
    }
  });

  it('tee_requested accepts explicit true', () => {
    const r = parse({ ...VALID, tee_requested: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tee_requested).toBe(true);
    }
  });

  it('rejects tee_requested with non-boolean', () => {
    expect(parse({ ...VALID, tee_requested: 'yes' }).success).toBe(false);
  });
});
