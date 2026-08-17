import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bmcCredentials, type BmcCredentials } from '../../../common/bmc.types';
import { TelegrafConfigWriterService } from '../telegraf-config-writer.service';
import type {
  ActiveDevicesPort,
  BmcCredentialsLookupPort,
  BridgePartitionerPort,
  InfraTargetsPort,
  PduVendorClassifierPort,
  TelegrafConfigWriterLogger,
} from '../telegraf-config-writer.types';

const SILENT_LOGGER: TelegrafConfigWriterLogger = {
  info: async () => {},
  warning: async () => {},
};

const RENDER_CONFIG = {
  bridge_api_url: 'https://bridge-api.test:443',
  poll_interval: '30s',
  timeout: '10s',
};

interface Harness {
  workDir: string;
  outputPath: string;
}

let harness: Harness;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tcw-'));
  harness = { workDir: dir, outputPath: join(dir, 'owned.conf') };
});

afterEach(async () => {
  await rm(harness.workDir, { recursive: true, force: true });
});

function partitioner(owned: Set<string>): BridgePartitionerPort & { owned: Set<string> } {
  return {
    owned,
    owns(id: string) {
      return this.owned.has(id);
    },
  };
}

function staticCreds(
  table: Record<string, BmcCredentials>,
): BmcCredentialsLookupPort & { table: Record<string, BmcCredentials> } {
  return {
    table,
    async get(id: string) {
      return this.table[id] ?? null;
    },
  };
}

function activeDevices(
  idsRef: { ids: string[] },
  data: Record<string, Record<string, unknown>> = {},
): ActiveDevicesPort {
  return {
    iterActiveDeviceIds: async function* () {
      for (const id of idsRef.ids) yield id;
    },
    async getCachedDeviceData(id) {
      return data[id] ?? null;
    },
  };
}

const INFRA_TARGETS: InfraTargetsPort = {
  extractRole(deviceData) {
    if (!deviceData || typeof deviceData !== 'object') return null;
    const role = (deviceData as { role?: unknown }).role;
    if (role && typeof role === 'object') {
      const slug = (role as { slug?: unknown }).slug;
      if (typeof slug === 'string') return slug.toLowerCase();
    }
    return null;
  },
  classifyRole(role) {
    if (role === 'pdu') return 'pdu';
    if (role === 'cdu') return 'cdu';
    return 'server';
  },
};

const PDU_CLASSIFIER: PduVendorClassifierPort = {
  classifyPduVendor(deviceData) {
    if (!deviceData) return null;
    const dt = (deviceData as { device_type?: { slug?: string } }).device_type;
    if (dt?.slug?.includes('vertiv')) return 'vertiv-geist';
    return null;
  },
};

function makeWriter(options: {
  owned: Set<string>;
  creds: Record<string, BmcCredentials>;
  idsRef: { ids: string[] };
  data?: Record<string, Record<string, unknown>>;
  debounceSeconds?: number;
}): TelegrafConfigWriterService {
  return new TelegrafConfigWriterService(
    partitioner(options.owned),
    staticCreds(options.creds),
    activeDevices(options.idsRef, options.data),
    INFRA_TARGETS,
    PDU_CLASSIFIER,
    {
      outputPath: harness.outputPath,
      renderConfig: RENDER_CONFIG,
      debounceSeconds: options.debounceSeconds ?? 30,
    },
    SILENT_LOGGER,
  );
}

async function readOutput(): Promise<string> {
  return readFile(harness.outputPath, 'utf-8');
}

function mgmtInterfaces(ip: string): Array<Record<string, unknown>> {
  return [{ mgmt_only: true, ip_addresses: [{ address: `${ip}/24` }] }];
}

describe('first write', () => {
  it('first tick writes immediately even at t=0', async () => {
    const idsRef = { ids: ['42'] };
    const writer = makeWriter({
      owned: new Set(['42']),
      creds: { '42': bmcCredentials('10.0.0.1', 'u', 'p') },
      idsRef,
    });
    expect(await writer.tick(0)).toBe(true);
    expect(await readOutput()).toContain('device 42');
  });

  it('first write with empty owned set produces header-only file', async () => {
    const writer = makeWriter({ owned: new Set(), creds: {}, idsRef: { ids: [] } });
    expect(await writer.tick(0)).toBe(true);
    const body = await readOutput();
    expect(body).toContain('Device count: 0');
    expect(body).not.toContain('[[inputs.http]]');
  });
});

describe('no-op ticks', () => {
  it('no change does not rewrite', async () => {
    const idsRef = { ids: ['42'] };
    const writer = makeWriter({
      owned: new Set(['42']),
      creds: { '42': bmcCredentials('10.0.0.1', 'u', 'p') },
      idsRef,
    });
    expect(await writer.tick(0)).toBe(true);
    const m1 = (await stat(harness.outputPath)).mtimeMs;
    expect(await writer.tick(60)).toBe(false);
    const m2 = (await stat(harness.outputPath)).mtimeMs;
    expect(m2).toBe(m1);
  });
});

describe('debounce', () => {
  it('change then wait then write', async () => {
    const idsRef = { ids: ['42'] };
    const ownedSet = new Set(['42']);
    const credsTable: Record<string, BmcCredentials> = { '42': bmcCredentials('10.0.0.1', 'u', 'p') };
    const writer = makeWriter({ owned: ownedSet, creds: credsTable, idsRef, debounceSeconds: 30 });

    expect(await writer.tick(0)).toBe(true);

    idsRef.ids = ['42', '99'];
    ownedSet.add('99');
    credsTable['99'] = bmcCredentials('10.0.0.2', 'u', 'p');

    expect(await writer.tick(10)).toBe(false);
    expect(await writer.tick(39)).toBe(false);
    expect(await writer.tick(40)).toBe(true);
    expect(await readOutput()).toContain('device 99');
  });

  it('burst changes reset debounce timer', async () => {
    const idsRef = { ids: ['42'] };
    const ownedSet = new Set(['42']);
    const credsTable: Record<string, BmcCredentials> = { '42': bmcCredentials('10.0.0.1', 'u', 'p') };
    const writer = makeWriter({ owned: ownedSet, creds: credsTable, idsRef, debounceSeconds: 30 });
    await writer.tick(0);

    idsRef.ids = ['42', '99'];
    ownedSet.add('99');
    credsTable['99'] = bmcCredentials('10.0.0.2', 'u', 'p');
    expect(await writer.tick(10)).toBe(false);

    idsRef.ids = ['42', '99', '100'];
    ownedSet.add('100');
    credsTable['100'] = bmcCredentials('10.0.0.3', 'u', 'p');
    expect(await writer.tick(25)).toBe(false);

    expect(await writer.tick(40)).toBe(false);
    expect(await writer.tick(55)).toBe(true);
  });
});

describe('compute owned devices', () => {
  it('device not owned is skipped', async () => {
    const idsRef = { ids: ['42', '99'] };
    const writer = makeWriter({
      owned: new Set(['42']),
      creds: {
        '42': bmcCredentials('10.0.0.1', 'u', 'p'),
        '99': bmcCredentials('10.0.0.2', 'u', 'p'),
      },
      idsRef,
    });
    await writer.tick(0);
    const body = await readOutput();
    expect(body).toContain('device 42');
    expect(body).not.toContain('device 99');
  });

  it('device without creds is skipped', async () => {
    const idsRef = { ids: ['42', '99'] };
    const writer = makeWriter({
      owned: new Set(['42', '99']),
      creds: { '42': bmcCredentials('10.0.0.1', 'u', 'p') },
      idsRef,
    });
    await writer.tick(0);
    const body = await readOutput();
    expect(body).toContain('device 42');
    expect(body).not.toContain('device 99');
  });

  it('rendered config is vendor-neutral', async () => {
    const idsRef = { ids: ['42'] };
    const writer = makeWriter({
      owned: new Set(['42']),
      creds: { '42': bmcCredentials('10.0.0.1', 'u', 'p') },
      idsRef,
    });
    await writer.tick(0);
    const body = await readOutput();
    expect(body).not.toContain('DellGPUSensors');
    expect(body).not.toContain('GraphicsControllers');
    expect(body).not.toContain('HGX_GPU');
    expect(body).toContain('/api/monitoring/device/sensors');
  });

  it('cdu device renders CDU stanza without a sealed BMC secret', async () => {
    const idsRef = { ids: ['cdu-1'] };
    const writer = makeWriter({
      owned: new Set(['cdu-1']),
      creds: {},
      idsRef,
      data: { 'cdu-1': { role: { slug: 'cdu' }, interfaces: mgmtInterfaces('10.4.0.14') } },
    });
    await writer.tick(0);
    const body = await readOutput();
    expect(body).toContain('"kind": "cdu"');
    expect(body).toContain('measurement_name = "cdu_leak_detector_ok"');
    expect(body).not.toContain('measurement_name = "gpu_temperature_celsius"');
  });

  it('pdu device renders SNMP stanza without a sealed BMC secret (agent IP from the blob)', async () => {
    const idsRef = { ids: ['pdu-1'] };
    const writer = makeWriter({
      owned: new Set(['pdu-1']),
      creds: {},
      idsRef,
      data: {
        'pdu-1': {
          role: { slug: 'pdu' },
          device_type: { slug: 'vertiv-geist-imd', manufacturer: { slug: 'vertiv' } },
          interfaces: mgmtInterfaces('10.4.0.2'),
        },
      },
    });
    await writer.tick(0);
    const body = await readOutput();
    expect(body).toContain('[[inputs.snmp]]');
    expect(body).toContain('agents = ["udp://10.4.0.2:161"]');
    expect(body).toContain('pdu_vendor = "vertiv-geist"');
    expect(body).toContain('/api/monitoring/ping');
    expect(body).not.toContain('/api/monitoring/device/sensors');
  });

  it('pdu with unrecognized vendor is still enrolled with ICMP only', async () => {
    const idsRef = { ids: ['pdu-1'] };
    const writer = makeWriter({
      owned: new Set(['pdu-1']),
      creds: {},
      idsRef,
      data: {
        'pdu-1': {
          role: { slug: 'pdu' },
          device_type: { slug: 'acme-power-3000' },
          interfaces: mgmtInterfaces('10.4.0.3'),
        },
      },
    });
    await writer.tick(0);
    const body = await readOutput();
    expect(body).toContain('device pdu-1');
    expect(body).toContain('/api/monitoring/ping');
    expect(body).not.toContain('[[inputs.snmp]]');
  });

  it('re-resolves targets after the refresh TTL so hub blob updates propagate', async () => {
    const idsRef = { ids: ['pdu-1'] };
    const data: Record<string, Record<string, unknown>> = {
      'pdu-1': {
        role: { slug: 'pdu' },
        device_type: { slug: 'vertiv-geist-imd' },
        interfaces: mgmtInterfaces('10.4.0.2'),
      },
    };
    const writer = makeWriter({ owned: new Set(['pdu-1']), creds: {}, idsRef, data, debounceSeconds: 0 });
    await writer.tick(0);
    expect(await readOutput()).toContain('udp://10.4.0.2:161');

    data['pdu-1'] = { ...data['pdu-1'], interfaces: mgmtInterfaces('10.4.0.99') };
    await writer.tick(10);
    expect(await readOutput()).toContain('udp://10.4.0.2:161');
    await writer.tick(301);
    expect(await readOutput()).toContain('udp://10.4.0.99:161');
  });

  it('evicts the cached target when the mgmt IP is removed (no stale scrape address survives the TTL)', async () => {
    const idsRef = { ids: ['pdu-1'] };
    const data: Record<string, Record<string, unknown>> = {
      'pdu-1': {
        role: { slug: 'pdu' },
        device_type: { slug: 'vertiv-geist-imd' },
        interfaces: mgmtInterfaces('10.4.0.2'),
      },
    };
    const writer = makeWriter({ owned: new Set(['pdu-1']), creds: {}, idsRef, data, debounceSeconds: 0 });
    await writer.tick(0);
    expect(await readOutput()).toContain('udp://10.4.0.2:161');

    data['pdu-1'] = { ...data['pdu-1'], interfaces: [] };
    await writer.tick(301);
    expect(await readOutput()).not.toContain('device pdu-1');
    await writer.tick(302);
    expect(await readOutput()).not.toContain('udp://10.4.0.2:161');
  });

  it('missing-IP warning fires once per device, not per tick', async () => {
    const warnings: string[] = [];
    const logger: TelegrafConfigWriterLogger = {
      info: async () => {},
      warning: async (message) => {
        warnings.push(message);
      },
    };
    const idsRef = { ids: ['pdu-1'] };
    const writer = new TelegrafConfigWriterService(
      partitioner(new Set(['pdu-1'])),
      staticCreds({}),
      activeDevices(idsRef, { 'pdu-1': { role: { slug: 'pdu' }, interfaces: [] } }),
      INFRA_TARGETS,
      PDU_CLASSIFIER,
      { outputPath: harness.outputPath, renderConfig: RENDER_CONFIG, debounceSeconds: 0 },
      logger,
    );
    await writer.tick(0);
    await writer.tick(1);
    await writer.tick(2);
    expect(warnings.filter((m) => m.includes('no mgmt-only IP'))).toHaveLength(1);
  });

  it('pdu without a mgmt-only IP is skipped (no scrape target)', async () => {
    const idsRef = { ids: ['pdu-1'] };
    const writer = makeWriter({
      owned: new Set(['pdu-1']),
      creds: {},
      idsRef,
      data: {
        'pdu-1': {
          role: { slug: 'pdu' },
          device_type: { slug: 'vertiv-geist-imd' },
          interfaces: [{ mgmt_only: false, ip_addresses: [{ address: '10.0.0.9/24' }] }],
        },
      },
    });
    await writer.tick(0);
    const body = await readOutput();
    expect(body).not.toContain('device pdu-1');
    expect(body).toContain('Device count: 0');
  });
});

describe('atomic write semantics', () => {
  it('file mode is 0o600', async () => {
    const idsRef = { ids: ['42'] };
    const writer = makeWriter({
      owned: new Set(['42']),
      creds: { '42': bmcCredentials('10.0.0.1', 'u', 'p') },
      idsRef,
    });
    await writer.tick(0);
    const mode = (await stat(harness.outputPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('no .tmp leftovers after successful write', async () => {
    const idsRef = { ids: ['42'] };
    const writer = makeWriter({
      owned: new Set(['42']),
      creds: { '42': bmcCredentials('10.0.0.1', 'u', 'p') },
      idsRef,
    });
    await writer.tick(0);
    const files = await readdir(harness.workDir);
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});

describe('hash + diff determinism', () => {
  it('identical partition across 100 ticks writes once', async () => {
    const idsRef = { ids: ['42'] };
    const writer = makeWriter({
      owned: new Set(['42']),
      creds: { '42': bmcCredentials('10.0.0.1', 'u', 'p') },
      idsRef,
    });
    let writes = 0;
    for (let i = 0; i < 100; i++) {
      if (await writer.tick(i)) writes += 1;
    }
    expect(writes).toBe(1);
  });
});

describe('creds caching', () => {
  function countingCreds(
    table: Record<string, BmcCredentials>,
  ): BmcCredentialsLookupPort & { calls: string[]; table: Record<string, BmcCredentials> } {
    return {
      table,
      calls: [],
      async get(id) {
        this.calls.push(id);
        return this.table[id] ?? null;
      },
    };
  }

  it('creds fetched once per device across ticks', async () => {
    const idsRef = { ids: ['d1', 'd2'] };
    const creds = countingCreds({
      d1: bmcCredentials('10.0.0.1', 'u', 'p'),
      d2: bmcCredentials('10.0.0.2', 'u', 'p'),
    });
    const writer = new TelegrafConfigWriterService(
      partitioner(new Set(['d1', 'd2'])),
      creds,
      activeDevices(idsRef),
      INFRA_TARGETS,
      PDU_CLASSIFIER,
      { outputPath: harness.outputPath, renderConfig: RENDER_CONFIG, debounceSeconds: 0 },
      SILENT_LOGGER,
    );
    for (let i = 0; i < 10; i++) await writer.tick(i);
    expect([...creds.calls].sort()).toEqual(['d1', 'd2']);
  });

  it('new device triggers fetch; existing does not', async () => {
    const idsRef = { ids: ['d1'] };
    const ownedSet = new Set(['d1', 'd2']);
    const creds = countingCreds({
      d1: bmcCredentials('10.0.0.1', 'u', 'p'),
      d2: bmcCredentials('10.0.0.2', 'u', 'p'),
    });
    const writer = new TelegrafConfigWriterService(
      partitioner(ownedSet),
      creds,
      activeDevices(idsRef),
      INFRA_TARGETS,
      PDU_CLASSIFIER,
      { outputPath: harness.outputPath, renderConfig: RENDER_CONFIG, debounceSeconds: 0 },
      SILENT_LOGGER,
    );
    await writer.tick(0);
    idsRef.ids = ['d1', 'd2'];
    await writer.tick(1);
    expect(creds.calls).toEqual(['d1', 'd2']);
  });

  it('departed device evicted and refetched on return', async () => {
    const idsRef = { ids: ['d1'] };
    const creds = countingCreds({ d1: bmcCredentials('10.0.0.1', 'u', 'p') });
    const writer = new TelegrafConfigWriterService(
      partitioner(new Set(['d1'])),
      creds,
      activeDevices(idsRef),
      INFRA_TARGETS,
      PDU_CLASSIFIER,
      { outputPath: harness.outputPath, renderConfig: RENDER_CONFIG, debounceSeconds: 0 },
      SILENT_LOGGER,
    );
    await writer.tick(0);
    idsRef.ids = [];
    await writer.tick(1);
    idsRef.ids = ['d1'];
    await writer.tick(2);
    expect(creds.calls).toEqual(['d1', 'd1']);
  });

  it('pdu devices never consult the creds lookup', async () => {
    const idsRef = { ids: ['pdu-1'] };
    const creds = countingCreds({});
    const writer = new TelegrafConfigWriterService(
      partitioner(new Set(['pdu-1'])),
      creds,
      activeDevices(idsRef, {
        'pdu-1': {
          role: { slug: 'pdu' },
          device_type: { slug: 'vertiv-geist-imd' },
          interfaces: mgmtInterfaces('10.4.0.2'),
        },
      }),
      INFRA_TARGETS,
      PDU_CLASSIFIER,
      { outputPath: harness.outputPath, renderConfig: RENDER_CONFIG, debounceSeconds: 0 },
      SILENT_LOGGER,
    );
    await writer.tick(0);
    expect(creds.calls).toEqual([]);
    expect(await readOutput()).toContain('device pdu-1');
  });

  it('unresolved device retried until creds appear', async () => {
    const idsRef = { ids: ['d1'] };
    const table: Record<string, BmcCredentials> = {};
    const creds = countingCreds(table);
    const writer = new TelegrafConfigWriterService(
      partitioner(new Set(['d1'])),
      creds,
      activeDevices(idsRef),
      INFRA_TARGETS,
      PDU_CLASSIFIER,
      { outputPath: harness.outputPath, renderConfig: RENDER_CONFIG, debounceSeconds: 0 },
      SILENT_LOGGER,
    );
    await writer.tick(0);
    await writer.tick(1);
    expect(creds.calls).toEqual(['d1', 'd1']);

    table['d1'] = bmcCredentials('10.0.0.1', 'u', 'p');
    await writer.tick(2);
    await writer.tick(3);
    expect(creds.calls).toEqual(['d1', 'd1', 'd1']);
  });
});
