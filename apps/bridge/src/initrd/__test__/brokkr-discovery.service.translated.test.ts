import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { BridgeRegistrySnapshot } from '../../bridge-network/bridge-registry-reader.js';
import { NIL_DEVICE_ID } from '../../common/redis/redis-keys.js';
import { getLogger } from '../../logger/logger.service.js';
import { BrokkrDiscoveryInitrdService } from '../brokkr-discovery-initrd.service.js';
import { CommonInitrdUtils } from '../common-utils.js';
import { resetInitrdConfigForTests } from '../initrd.config.js';

vi.mock('../ssh-key.service.js', () => ({
  createSshKeyService: vi.fn(async () => ({
    getBridgeSshKeys: async () => ['ssh-ed25519 BRIDGEADMINKEY admin'],
  })),
}));

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['BROKKR_ZONE_ID', 'BRIDGE_URL', 'ENVIRONMENT', 'LOCAL_SIMULATION_ENABLED']) {
    savedEnv[key] = process.env[key];
  }
  process.env.BROKKR_ZONE_ID = '00000000-0000-4000-8000-000000000001';
  process.env.BRIDGE_URL = 'https://bridge.example.com';
  delete process.env.LOCAL_SIMULATION_ENABLED;
  resetInitrdConfigForTests();
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetInitrdConfigForTests();
});

interface FakeDeps {
  fetchLiveNetplanForInitrd: Mock<(...args: any[]) => any>;
  createBridgeIpResolutionService: Mock<(...args: any[]) => any>;
  getBridgeHostsEntriesForClient: Mock<(...args: any[]) => any>;
  getAllBridgeHostnames: Mock<(...args: any[]) => any>;
  getBridgeRegistrySnapshot: Mock<(...args: any[]) => any>;
  agentTokens: {
    mintOrReuseDevice: Mock<(...args: any[]) => any>;
    mintOrReuseDiscovery: Mock<(...args: any[]) => any>;
  };
}

function makeDeps(overrides: Partial<FakeDeps> = {}): FakeDeps {
  return {
    fetchLiveNetplanForInitrd:
      overrides.fetchLiveNetplanForInitrd ?? vi.fn(async () => 'version: 2\nethernets:\n  eth0:\n    dhcp4: true'),
    createBridgeIpResolutionService:
      overrides.createBridgeIpResolutionService ??
      vi.fn(async () => ({
        getBridgeIpForDevice: async () => '10.0.0.1',
        getBridgeIpForHostsFile: async () => '10.0.0.1',
        resolveBridgeIpForDevice: async () => ({ ip: '10.0.0.1', authoritative: true }),
      })),
    getBridgeHostsEntriesForClient:
      overrides.getBridgeHostsEntriesForClient ??
      vi.fn(async () => [
        ['10.0.0.231', 'bridge-9-57-16-231'],
        ['10.0.0.232', 'bridge-9-57-16-232'],
      ]),
    getAllBridgeHostnames: overrides.getAllBridgeHostnames ?? vi.fn(async () => []),
    getBridgeRegistrySnapshot: overrides.getBridgeRegistrySnapshot ?? vi.fn(async () => []),
    agentTokens: overrides.agentTokens ?? {
      mintOrReuseDevice: vi.fn(async () => 'test-agent-token'),
      mintOrReuseDiscovery: vi.fn(async () => 'test-agent-token'),
    },
  };
}

function asMutable(service: BrokkrDiscoveryInitrdService) {
  return service as unknown as {
    collectTemplateVariables(
      deviceData: Record<string, unknown> | null,
      deviceId: string,
      jobId: string,
      clientIp: string,
    ): Promise<Record<string, unknown>>;
    renderAllTemplates(initrdDir: string, templateVars: Record<string, unknown>): Promise<void>;
  };
}

describe('BrokkrDiscoveryInitrdService.collectTemplateVariables — phone-home omission', () => {
  it('omits phone-home creds and uses the first static address with bridge matches', async () => {
    const getBridgeHostsEntriesForClient = vi.fn(async (clientIp: string) =>
      clientIp === '172.16.8.11'
        ? [
            ['10.0.0.231', 'bridge-9-57-16-231'],
            ['10.0.0.232', 'bridge-9-57-16-232'],
          ]
        : [],
    );
    const deps = makeDeps({
      fetchLiveNetplanForInitrd: vi.fn(
        async () => `network:
  version: 2
  ethernets:
    eth0:
      addresses:
        - 172.16.8.10/24
        - 172.16.8.11/24
        - 172.16.8.12/24
`,
      ),
      getBridgeHostsEntriesForClient,
    });
    const service = new BrokkrDiscoveryInitrdService('test-job', deps);

    const templateVars = await asMutable(service).collectTemplateVariables(
      {
        status: 'active',
        platform_slug: 'dell-r740',
        tenant_id: 1,
        site_id: 2,
        location_id: 3,
        netplan: 'version: 2\nethernets:\n  eth0:\n    dhcp4: true',
      },
      '42',
      'test-job',
      '192.0.2.50',
    );

    expect(templateVars).not.toHaveProperty('phone_home_cipher');
    expect(templateVars).not.toHaveProperty('phone_home_signature');
    expect(templateVars).not.toHaveProperty('phone_home_endpoint');
    expect(templateVars.agent_token).toBe('test-agent-token');
    expect(templateVars.zone_id).toBe('00000000-0000-4000-8000-000000000001');
    expect(templateVars.bridge_hosts).toEqual([
      { ip: '10.0.0.231', hostname: 'bridge-9-57-16-231' },
      { ip: '10.0.0.232', hostname: 'bridge-9-57-16-232' },
    ]);
    expect(getBridgeHostsEntriesForClient).toHaveBeenCalledTimes(2);
    expect(getBridgeHostsEntriesForClient).toHaveBeenNthCalledWith(1, '172.16.8.10', 'test-job', '10.0.0.1');
    expect(getBridgeHostsEntriesForClient).toHaveBeenNthCalledWith(2, '172.16.8.11', 'test-job', '10.0.0.1');
    expect(deps.agentTokens.mintOrReuseDevice).toHaveBeenCalledWith('42', 'test-job');
  });

  it('queries every valid static address before it uses the client address', async () => {
    const getBridgeHostsEntriesForClient = vi.fn(
      async (clientIp: string): Promise<ReadonlyArray<readonly [string, string]>> =>
        clientIp === '192.0.2.50' ? [['10.0.0.231', 'bridge-9-57-16-231']] : [],
    );
    const deps = makeDeps({
      fetchLiveNetplanForInitrd: vi.fn(
        async () => `network:
  version: 2
  ethernets:
    eth0:
      addresses: [192.0.2.10/24, invalid]
  bonds:
    bond0:
      addresses: [198.51.100.20/24]
  vlans:
    vlan10:
      addresses: [203.0.113.30/24]
`,
      ),
      getBridgeHostsEntriesForClient,
    });
    const service = new BrokkrDiscoveryInitrdService('test-job', deps);

    const templateVars = await asMutable(service).collectTemplateVariables(null, '42', 'test-job', '192.0.2.50');

    expect(templateVars.bridge_hosts).toEqual([{ ip: '10.0.0.231', hostname: 'bridge-9-57-16-231' }]);
    expect(getBridgeHostsEntriesForClient.mock.calls.map(([address]) => address)).toEqual([
      '192.0.2.10',
      '198.51.100.20',
      '203.0.113.30',
      '192.0.2.50',
    ]);
  });

  it('uses the client address when the netplan has no usable static addresses', async () => {
    const deps = makeDeps({
      fetchLiveNetplanForInitrd: vi.fn(
        async () => `network:
  version: 2
  ethernets:
    eth0:
      dhcp4: true
      addresses: [invalid, 999.0.0.1/24]
`,
      ),
    });
    const service = new BrokkrDiscoveryInitrdService('test-job', deps);

    const templateVars = await asMutable(service).collectTemplateVariables(
      {
        status: 'active',
        platform_slug: 'dell-r740',
        tenant_id: 1,
        site_id: 2,
        location_id: 3,
        netplan: '',
      },
      '42',
      'test-job',
      '192.0.2.50',
    );

    expect(templateVars.bridge_hosts).toEqual([
      { ip: '10.0.0.231', hostname: 'bridge-9-57-16-231' },
      { ip: '10.0.0.232', hostname: 'bridge-9-57-16-232' },
    ]);
    expect(deps.getBridgeHostsEntriesForClient).toHaveBeenCalledWith('192.0.2.50', 'test-job', '10.0.0.1');
  });
});

describe('BrokkrDiscoveryInitrdService.collectTemplateVariables — routed peer fallback', () => {
  const ROUTED_NETPLAN = `network:
  version: 2
  ethernets:
    eth0:
      addresses:
        - 10.9.0.210/30
`;

  const SITE_SNAPSHOT: BridgeRegistrySnapshot = [
    [
      'bridge-2247-334-242-3427',
      [
        { iface: 'eth3', subnet: '10.2.0.0/16', ip: '10.2.0.2' },
        { iface: 'eth4', subnet: '10.100.0.0/16', ip: '10.100.0.1' },
      ],
    ],
    ['bridge-2247-334-242-3428', [{ iface: 'eth3', subnet: '10.2.0.0/16', ip: '10.2.0.3' }]],
  ];

  function routedDeps(bridgeIp: { ip: string; authoritative: boolean }, snapshot: BridgeRegistrySnapshot) {
    const getBridgeHostsEntriesForClient = vi.fn(
      async (_clientIp: string, _jobId: string, fallbackAddr?: string | null) =>
        fallbackAddr === '10.2.0.2'
          ? [
              ['10.2.0.2', 'bridge-2247-334-242-3427'],
              ['10.2.0.3', 'bridge-2247-334-242-3428'],
            ]
          : [['10.100.0.1', 'bridge-2247-334-242-3427']],
    );
    const deps = makeDeps({
      fetchLiveNetplanForInitrd: vi.fn(async () => ROUTED_NETPLAN),
      createBridgeIpResolutionService: vi.fn(async () => ({
        getBridgeIpForDevice: async () => bridgeIp.ip,
        getBridgeIpForHostsFile: async () => bridgeIp.ip,
        resolveBridgeIpForDevice: async () => bridgeIp,
      })),
      getBridgeHostsEntriesForClient,
      getBridgeRegistrySnapshot: vi.fn(async () => snapshot),
    });
    return { deps, getBridgeHostsEntriesForClient };
  }

  function partialWarnings(warning: Mock<(...args: any[]) => any>): string[] {
    return warning.mock.calls.map(([msg]) => String(msg)).filter((msg) => msg.startsWith('Partial bridge_hosts'));
  }

  it('passes an authoritative bridge IP as the peer fallback and lists both bridges', async () => {
    const warning = vi.spyOn(getLogger(), 'warning');
    try {
      const { deps, getBridgeHostsEntriesForClient } = routedDeps(
        { ip: '10.2.0.2', authoritative: true },
        SITE_SNAPSHOT,
      );
      const service = new BrokkrDiscoveryInitrdService('test-job', deps);

      const templateVars = await asMutable(service).collectTemplateVariables(null, '42', 'test-job', '10.9.0.210');

      expect(templateVars.bridge_ip).toBe('10.2.0.2');
      expect(getBridgeHostsEntriesForClient).toHaveBeenNthCalledWith(1, '10.9.0.210', 'test-job', '10.2.0.2');
      expect(templateVars.bridge_hosts).toEqual([
        { ip: '10.2.0.2', hostname: 'bridge-2247-334-242-3427' },
        { ip: '10.2.0.3', hostname: 'bridge-2247-334-242-3428' },
      ]);
      expect(partialWarnings(warning)).toEqual([]);
    } finally {
      warning.mockRestore();
    }
  });

  it('skips the peer fallback for a non-authoritative bridge IP and names the missing bridge', async () => {
    const warning = vi.spyOn(getLogger(), 'warning');
    try {
      const { deps, getBridgeHostsEntriesForClient } = routedDeps(
        { ip: '192.168.105.33', authoritative: false },
        SITE_SNAPSHOT,
      );
      const service = new BrokkrDiscoveryInitrdService('test-job', deps);

      const templateVars = await asMutable(service).collectTemplateVariables(null, '42', 'test-job', '10.9.0.210');

      expect(templateVars.bridge_ip).toBe('192.168.105.33');
      expect(getBridgeHostsEntriesForClient).toHaveBeenCalledTimes(1);
      expect(getBridgeHostsEntriesForClient).toHaveBeenCalledWith('10.9.0.210', 'test-job', null);
      expect(templateVars.bridge_hosts).toEqual([{ ip: '10.100.0.1', hostname: 'bridge-2247-334-242-3427' }]);
      const warnings = partialWarnings(warning);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('bridge-2247-334-242-3428');
      expect(warnings[0]).not.toContain('bridge-2247-334-242-3427');
    } finally {
      warning.mockRestore();
    }
  });

  it('does not warn for a non-authoritative bridge IP when no eligible bridge is missing', async () => {
    const warning = vi.spyOn(getLogger(), 'warning');
    try {
      const snapshot: BridgeRegistrySnapshot = [
        SITE_SNAPSHOT[0],
        ['bridge-2247-334-242-3428', [{ iface: 'wt0', subnet: '100.125.0.0/16', ip: '100.125.9.9' }]],
      ];
      const { deps } = routedDeps({ ip: '192.168.105.33', authoritative: false }, snapshot);
      const service = new BrokkrDiscoveryInitrdService('test-job', deps);

      const templateVars = await asMutable(service).collectTemplateVariables(null, '42', 'test-job', '10.9.0.210');

      expect(templateVars.bridge_hosts).toEqual([{ ip: '10.100.0.1', hostname: 'bridge-2247-334-242-3427' }]);
      expect(partialWarnings(warning)).toEqual([]);
    } finally {
      warning.mockRestore();
    }
  });
});

describe('BrokkrDiscoveryInitrdService.collectTemplateVariables — NIL commissioning token', () => {
  it('mints a MAC-keyed discovery token when the NIL build carries a MAC', async () => {
    const deps = makeDeps();
    const service = new BrokkrDiscoveryInitrdService('test-job', deps);

    const templateVars = await asMutable(service).collectTemplateVariables(
      { id: NIL_DEVICE_ID, mac: 'AA:BB:CC:DD:EE:FF' },
      NIL_DEVICE_ID,
      'test-job',
      '192.0.2.50',
    );

    expect(templateVars.agent_token).toBe('test-agent-token');
    expect(deps.agentTokens.mintOrReuseDiscovery).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 'test-job');
    expect(deps.agentTokens.mintOrReuseDevice).not.toHaveBeenCalled();
  });

  it('PXE-01: mints an anonymous NIL-keyed discovery token when no MAC is present', async () => {
    const deps = makeDeps();
    const service = new BrokkrDiscoveryInitrdService('test-job', deps);

    const templateVars = await asMutable(service).collectTemplateVariables(
      { id: NIL_DEVICE_ID },
      NIL_DEVICE_ID,
      'test-job',
      '192.0.2.50',
    );

    expect(templateVars.agent_token).toBe('test-agent-token');
    expect(deps.agentTokens.mintOrReuseDiscovery).toHaveBeenCalledWith(NIL_DEVICE_ID, 'test-job');
    expect(deps.agentTokens.mintOrReuseDevice).not.toHaveBeenCalled();
  });

  it('still surfaces a non-string MAC as a TypeError', async () => {
    const deps = makeDeps();
    const service = new BrokkrDiscoveryInitrdService('test-job', deps);

    await expect(
      asMutable(service).collectTemplateVariables(
        { id: NIL_DEVICE_ID, mac: 12345 },
        NIL_DEVICE_ID,
        'test-job',
        '192.0.2.50',
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('BrokkrDiscoveryInitrdService.renderAllTemplates — bin script permissions', () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'render-tests-'));
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function fresh(name: string): Promise<string> {
    const dir = join(tmpRoot, `${name}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it('writes 0o755 to extensionless bin scripts and strips the .njk source', async () => {
    const service = new BrokkrDiscoveryInitrdService('test-job', makeDeps(), new CommonInitrdUtils('test-job'));
    const root = await fresh('bin-noext');
    const binDir = join(root, 'usr', 'local', 'bin');
    await mkdir(binDir, { recursive: true });
    const templateFile = join(binDir, 'my-script.njk');
    await writeFile(templateFile, '{{ body }}');

    await asMutable(service).renderAllTemplates(root, { body: '#!/bin/bash\necho hello' });

    const outputFile = join(binDir, 'my-script');
    expect(await readFile(outputFile, 'utf8')).toBe('#!/bin/bash\necho hello');
    const mode = (await stat(outputFile)).mode & 0o777;
    expect(mode).toBe(0o755);
    await expect(stat(templateFile)).rejects.toThrow();
  });

  it('writes 0o755 to .sh scripts', async () => {
    const service = new BrokkrDiscoveryInitrdService('test-job', makeDeps(), new CommonInitrdUtils('test-job'));
    const root = await fresh('sh-script');
    const scriptsDir = join(root, 'usr', 'local', 'bin');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'setup.sh.njk'), '#!/bin/bash\necho {{ msg }}');

    await asMutable(service).renderAllTemplates(root, { msg: 'hello' });

    const mode = (await stat(join(scriptsDir, 'setup.sh'))).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('leaves non-bin config files at 0o644 (no execute bit)', async () => {
    const service = new BrokkrDiscoveryInitrdService('test-job', makeDeps(), new CommonInitrdUtils('test-job'));
    const root = await fresh('etc-config');
    const etcDir = join(root, 'etc');
    await mkdir(etcDir, { recursive: true });
    await writeFile(join(etcDir, 'config.conf.njk'), 'setting={{ value }}');

    await asMutable(service).renderAllTemplates(root, { value: '42' });

    const mode = (await stat(join(etcDir, 'config.conf'))).mode & 0o777;
    expect(mode).not.toBe(0o755);
  });
});

describe('BrokkrDiscoveryInitrdService.buildBrokkrDiscoveryInitrd — output filename', () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'output-name-'));
    process.env.PERSISTENT_STORAGE_PATH = tmpRoot;
    resetInitrdConfigForTests();
  });

  afterAll(async () => {
    delete process.env.PERSISTENT_STORAGE_PATH;
    resetInitrdConfigForTests();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function runBuild(outputName: string | null): Promise<{ executedOutput: string | null }> {
    const utils = new CommonInitrdUtils('test-job');
    let executedOutput: string | null = null;
    utils.executeInitrdBuild = (async (_initrdDir: string, outputFile: string) => {
      executedOutput = outputFile;
      await writeFile(outputFile, Buffer.from('img'));
    }) as typeof utils.executeInitrdBuild;

    const deps = makeDeps();
    const service = new BrokkrDiscoveryInitrdService('t', deps, utils);
    const collectSpy = vi
      .spyOn(
        asMutable(service) as unknown as {
          collectTemplateVariables: (...a: unknown[]) => Promise<Record<string, unknown>>;
        },
        'collectTemplateVariables',
      )
      .mockResolvedValue({});
    const renderSpy = vi
      .spyOn(
        asMutable(service) as unknown as { renderAllTemplates: (...a: unknown[]) => Promise<void> },
        'renderAllTemplates',
      )
      .mockResolvedValue();
    const assetsSpy = vi
      .spyOn(
        service as unknown as { copyDeviceAssetsToInitrd: (...a: unknown[]) => Promise<void> },
        'copyDeviceAssetsToInitrd',
      )
      .mockResolvedValue();

    await service.buildBrokkrDiscoveryInitrd(
      'job-1',
      '0',
      { id: 0, mac: 'aa:bb:cc:dd:ee:ff' },
      outputName,
      '192.0.2.50',
    );
    expect(collectSpy).toHaveBeenCalledWith({ id: 0, mac: 'aa:bb:cc:dd:ee:ff' }, '0', 'job-1', '192.0.2.50');

    collectSpy.mockRestore();
    renderSpy.mockRestore();
    assetsSpy.mockRestore();
    return { executedOutput };
  }

  it('writes the image to the requested MAC-keyed build name when output_name is provided', async () => {
    const macName = 'brokkr-discovery-mac-aabbccddeeff.img';
    const { executedOutput } = await runBuild(macName);

    const buildsDir = join(tmpRoot, 'initrd-builds');
    expect(executedOutput).toBe(join(buildsDir, macName));
    await expect(stat(join(buildsDir, macName))).resolves.toBeDefined();
    await expect(stat(join(buildsDir, 'brokkr-discovery-0.img'))).rejects.toThrow();
  });

  it('defaults to the device_id-keyed name when output_name is omitted', async () => {
    const { executedOutput } = await runBuild(null);
    const buildsDir = join(tmpRoot, 'initrd-builds');
    expect(executedOutput).toBe(join(buildsDir, 'brokkr-discovery-0.img'));
    await expect(stat(join(buildsDir, 'brokkr-discovery-0.img'))).resolves.toBeDefined();
  });
});
