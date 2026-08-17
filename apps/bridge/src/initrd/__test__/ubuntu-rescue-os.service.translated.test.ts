import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { CommonInitrdUtils } from '../common-utils.js';
import { resetInitrdConfigForTests } from '../initrd.config.js';
import { createUbuntuRescueOsInitrdService, UbuntuRescueOsInitrdService } from '../ubuntu-rescue-os-initrd.service.js';

vi.mock('../ssh-key.service.js', () => ({
  createSshKeyService: vi.fn(async () => ({
    getBridgeSshKeys: async () => ['ssh-ed25519 BRIDGEADMINKEY admin'],
  })),
}));

vi.mock('../phone-home.service.js', () => ({
  createPhoneHomeService: vi.fn(async () => ({
    getPhoneHomeVariables: async () => ({
      brokkr_live_token: 'test-live-token',
      phone_home_endpoint: 'https://x',
    }),
  })),
  PhoneHomeCredsUnavailable: class extends Error {},
}));

const savedEnv: Record<string, string | undefined> = {};
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'rescue-test-'));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of ['BROKKR_ENV', 'ENVIRONMENT', 'LOCAL_SIMULATION_ENABLED']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetInitrdConfigForTests();
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetInitrdConfigForTests();
});

async function writeAuthorizedKeysTemplate(initrdDir: string): Promise<void> {
  const tmpl = join(initrdDir, 'authorized_keys.njk');
  await writeFile(tmpl, '{% for k in pubkeys %}{{ k }}\n{% endfor %}');
}

function makeService(deviceSshKeys: string | null): UbuntuRescueOsInitrdService {
  const cache = {
    get: vi.fn(async () => deviceSshKeys),
  };
  return new UbuntuRescueOsInitrdService(
    'job-1',
    {
      cache,
      fetchLiveNetplanForInitrd: async () => '',
      getServerTokenAtom: async () => ({ brokkr_live_token: 'test-live-token', endpoint: 'https://x', exp: 1 }),
    },
    new CommonInitrdUtils('job-1'),
  );
}

function asMutable(service: UbuntuRescueOsInitrdService) {
  return service as unknown as {
    renderRescueTemplates(initrdDir: string, deviceId: string, jobId: string): Promise<void>;
  };
}

describe('UbuntuRescueOsInitrdService.renderRescueTemplates — SSH key merging', () => {
  it('appends Redis device-specific rescue keys after the bridge admin keys', async () => {
    const initrdDir = join(tmpRoot, `merge-${Math.random().toString(36).slice(2)}`);
    await mkdir(initrdDir, { recursive: true });
    await writeAuthorizedKeysTemplate(initrdDir);

    const service = makeService('ssh-rsa DEVICEKEY1 user\nssh-ed25519 DEVICEKEY2 user');
    const cacheGet = (service as unknown as { deps: { cache: { get: Mock<(...args: any[]) => any> } } }).deps.cache.get;

    await asMutable(service).renderRescueTemplates(initrdDir, '99', 'job-1');

    expect(cacheGet).toHaveBeenCalledWith('device:99:rescue:ssh_pub_keys', 'job-1');

    const rendered = await readFile(join(initrdDir, 'authorized_keys'), 'utf8');
    expect(rendered).toContain('BRIDGEADMINKEY');
    expect(rendered).toContain('DEVICEKEY1');
    expect(rendered).toContain('DEVICEKEY2');
    expect(rendered.indexOf('BRIDGEADMINKEY')).toBeLessThan(rendered.indexOf('DEVICEKEY1'));
  });

  it('falls back to bridge admin keys only when the Redis key is missing', async () => {
    const initrdDir = join(tmpRoot, `null-${Math.random().toString(36).slice(2)}`);
    await mkdir(initrdDir, { recursive: true });
    await writeAuthorizedKeysTemplate(initrdDir);

    const service = makeService(null);
    await asMutable(service).renderRescueTemplates(initrdDir, '7', 'job-2');

    const rendered = await readFile(join(initrdDir, 'authorized_keys'), 'utf8');
    expect(rendered).toContain('BRIDGEADMINKEY');
    expect(rendered).not.toContain('DEVICEKEY');
  });

  it('falls back to bridge admin keys only when the Redis key is the empty string', async () => {
    const initrdDir = join(tmpRoot, `empty-${Math.random().toString(36).slice(2)}`);
    await mkdir(initrdDir, { recursive: true });
    await writeAuthorizedKeysTemplate(initrdDir);

    const service = makeService('');
    await asMutable(service).renderRescueTemplates(initrdDir, '8', 'job-3');

    const rendered = await readFile(join(initrdDir, 'authorized_keys'), 'utf8');
    expect(rendered).toContain('BRIDGEADMINKEY');
  });
});

describe('createUbuntuRescueOsInitrdService', () => {
  it('returns an UbuntuRescueOsInitrdService instance bound to the supplied jobId', async () => {
    const service = await createUbuntuRescueOsInitrdService('factory-job', {
      cache: { get: async () => null },
      fetchLiveNetplanForInitrd: async () => '',
      getServerTokenAtom: async () => null,
    });
    expect(service).toBeInstanceOf(UbuntuRescueOsInitrdService);
    expect(service.jobId).toBe('factory-job');
  });
});
