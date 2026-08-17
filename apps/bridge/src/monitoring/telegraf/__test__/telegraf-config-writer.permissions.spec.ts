import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { openCalls, mkdirCalls } = vi.hoisted(() => ({
  openCalls: [] as Array<{ flags: unknown; mode: unknown }>,
  mkdirCalls: [] as Array<{ options: unknown }>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (path: Parameters<typeof actual.open>[0], flags: unknown, mode: unknown) => {
      openCalls.push({ flags, mode });
      return actual.open(path as never, flags as never, mode as never);
    },
    mkdir: (path: Parameters<typeof actual.mkdir>[0], options: unknown) => {
      mkdirCalls.push({ options });
      return actual.mkdir(path as never, options as never);
    },
  };
});

const SILENT_LOGGER: TelegrafConfigWriterLogger = {
  info: async () => {},
  warning: async () => {},
};

const RENDER_CONFIG = {
  bridge_api_url: 'https://bridge-api.test:443',
  poll_interval: '30s',
  timeout: '10s',
};

function partitioner(owned: Set<string>): BridgePartitionerPort {
  return { owns: (id: string) => owned.has(id) };
}

function staticCreds(table: Record<string, BmcCredentials>): BmcCredentialsLookupPort {
  return { get: async (id: string) => table[id] ?? null };
}

function activeDevices(ids: string[]): ActiveDevicesPort {
  return {
    iterActiveDeviceIds: async function* () {
      for (const id of ids) yield id;
    },
    getCachedDeviceData: async () => null,
  };
}

const INFRA_TARGETS: InfraTargetsPort = {
  extractRole: () => null,
  classifyRole: () => 'server',
};

const PDU_CLASSIFIER: PduVendorClassifierPort = {
  classifyPduVendor: () => null,
};

let workDir: string;
let outputPath: string;

beforeEach(async () => {
  openCalls.length = 0;
  mkdirCalls.length = 0;
  const { mkdtemp } = await import('node:fs/promises');
  workDir = await mkdtemp(join(tmpdir(), 'tcw-perm-'));
  outputPath = join(workDir, 'owned.conf');
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workDir, { recursive: true, force: true });
});

describe('telegraf config writer creation-time permissions', () => {
  function makeWriter(): TelegrafConfigWriterService {
    return new TelegrafConfigWriterService(
      partitioner(new Set(['42'])),
      staticCreds({ '42': bmcCredentials('10.0.0.1', 'user', 'secret-pw') }),
      activeDevices(['42']),
      INFRA_TARGETS,
      PDU_CLASSIFIER,
      { outputPath, renderConfig: RENDER_CONFIG, debounceSeconds: 0 },
      SILENT_LOGGER,
    );
  }

  it('creates the temp creds file with 0o600 at open time (no world-readable window)', async () => {
    await makeWriter().tick(0);

    expect(openCalls.length).toBeGreaterThan(0);
    for (const call of openCalls) {
      expect(call.mode).toBe(0o600);
    }
  });

  it('creates the parent directory with 0o700', async () => {
    await makeWriter().tick(0);

    expect(mkdirCalls.length).toBeGreaterThan(0);
    for (const call of mkdirCalls) {
      const options = call.options as { mode?: number } | undefined;
      expect(options?.mode).toBe(0o700);
    }
  });
});
