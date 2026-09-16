import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplicationConfig, resetApplicationConfigForTests } from '../core/application.config';
import { buildDocsConfig, resetDocsConfigForTests } from '../docs/docs.config';
import { buildInitrdConfig, resetInitrdConfigForTests } from '../initrd/initrd.config';
import { buildIpxeConfig, resetIpxeConfigForTests } from '../ipxe/ipxe.config';

const APPS_BRIDGE_ASSETS = resolve(__dirname, '..', '..', 'assets');

const REQUIRED_TEMPLATES: readonly string[] = [
  'ipxe/brokkr_live.ipxe.njk',
  'ipxe/custom.ipxe.njk',
  'ipxe/disk.ipxe.njk',
  'ipxe/retry.ipxe.njk',
  'ipxe/shell.ipxe.njk',
  'ipxe/unknown.ipxe.njk',
  'initrd/brokkr-discovery/etc/hosts.njk',
  'initrd/brokkr-discovery/brokkr/etc/hostname.njk',
  'initrd/brokkr-discovery/brokkr/etc/hosts.njk',
  'initrd/brokkr-discovery/brokkr/etc/netplan/zz-brokkr.yaml.njk',
  'initrd/brokkr-discovery/brokkr/opt/brokkr/agent.yaml.njk',
  'initrd/brokkr-discovery/brokkr/opt/brokkr/bridge-api-version.njk',
  'initrd/brokkr-discovery/brokkr/opt/brokkr/lockscreen.env.njk',
  'initrd/brokkr-discovery/brokkr/root/.ssh/authorized_keys.njk',
  'initrd/ubuntu-rescue-os/brokkr/etc/hostname.njk',
  'initrd/ubuntu-rescue-os/brokkr/etc/hosts.njk',
  'initrd/ubuntu-rescue-os/brokkr/etc/netplan/zz-brokkr.yaml.njk',
  'initrd/ubuntu-rescue-os/brokkr/root/.ssh/authorized_keys.njk',
  'initrd/ubuntu-rescue-os/brokkr/usr/local/bin/phone-home.njk',
  'docs/redoc.html.njk',
  'docs/swagger.html.njk',
  'telegraf/owned-devices.conf.njk',
];

afterEach(() => {
  resetApplicationConfigForTests();
  resetDocsConfigForTests();
  resetIpxeConfigForTests();
  resetInitrdConfigForTests();
});

describe('apps/bridge/assets/ bundle', () => {
  it('ships every required .njk template under apps/bridge/assets/', () => {
    const missing: string[] = [];
    for (const relPath of REQUIRED_TEMPLATES) {
      const absPath = resolve(APPS_BRIDGE_ASSETS, relPath);
      if (!existsSync(absPath)) missing.push(relPath);
    }
    expect(missing).toEqual([]);
  });

  it('exposes a non-empty api-description.md (DocsConfig openapiInfo source)', () => {
    const absPath = resolve(APPS_BRIDGE_ASSETS, 'docs', 'api-description.md');
    expect(existsSync(absPath)).toBe(true);
    const body = readFileSync(absPath, 'utf-8');
    expect(body.length).toBeGreaterThan(0);
  });
});

describe('runtime renderer paths anchor at apps/bridge/assets/', () => {
  it('ApplicationConfig.assetsDir resolves to apps/bridge/assets/', () => {
    const cfg = buildApplicationConfig({});
    expect(cfg.assetsDir).toBe(APPS_BRIDGE_ASSETS);
  });

  it('InitrdConfig.assetsDir resolves to apps/bridge/assets/', () => {
    const cfg = buildInitrdConfig({ BROKKR_ZONE_ID: 'zone-test' });
    expect(cfg.assetsDir).toBe(APPS_BRIDGE_ASSETS);
  });

  it('IpxeConfig.assetsDir points at apps/bridge/assets/ipxe/ when ASSETS_DIR overrides default', () => {
    const cfg = buildIpxeConfig({ ASSETS_DIR: APPS_BRIDGE_ASSETS });
    expect(cfg.assetsDir).toBe(resolve(APPS_BRIDGE_ASSETS, 'ipxe'));
  });

  it('DocsConfig.docsAssetsPath points at apps/bridge/assets/docs/ when ASSETS_DIR overrides default', () => {
    const cfg = buildDocsConfig({ ASSETS_DIR: APPS_BRIDGE_ASSETS });
    expect(cfg.docsAssetsPath).toBe(resolve(APPS_BRIDGE_ASSETS, 'docs'));
  });
});

describe('renderer integration smoke — non-empty bytes from new asset path', () => {
  it('IpxeTemplateRenderer renders all six chain variants from apps/bridge/assets/ipxe/', async () => {
    const { IpxeTemplateRenderer } = await import('../ipxe/ipxe-renderer.service');
    const config = buildIpxeConfig({ ASSETS_DIR: APPS_BRIDGE_ASSETS });
    const renderer = new IpxeTemplateRenderer(config, async () => ({
      brokkr_live_token: 'test-live-token',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
      exp: 1_730_000_000,
    }));

    const discovery = await renderer.render_discovery({
      arch: 'amd64',
      platform: 'brokkr-discovery',
      platform_type: 'standard',
      device_id: 'dev-test',
      serial_port: null,
      job_id: 'job-test',
      kernel_network: [],
      pci_realloc_off: false,
      flavor: 'full',
    });
    expect(discovery.length).toBeGreaterThan(0);

    const disk = await renderer.render_disk({ platform: 'p', arch: 'amd64' });
    expect(disk.length).toBeGreaterThan(0);

    const unknown = await renderer.render_unknown({ buildarch: 'amd64', platform: 'p' });
    expect(unknown.length).toBeGreaterThan(0);

    const retry = await renderer.render_retry();
    expect(retry.length).toBeGreaterThan(0);

    const shell = await renderer.render_shell({ operating_system: 'ubuntu', status: 'idle' });
    expect(shell.length).toBeGreaterThan(0);

    const custom = await renderer.render_custom({
      ipxe_url: 'https://hub/custom',
      device_id: 'dev-test',
    });
    expect(custom.length).toBeGreaterThan(0);
  });

  it('DocsService renders swagger + redoc HTML from apps/bridge/assets/docs/', async () => {
    const { DocsService } = await import('../docs/docs.service');
    const { ContextLogger } = await import('../logger/logger.service');
    const logger = new ContextLogger();

    const prev = process.env.ASSETS_DIR;
    process.env.ASSETS_DIR = APPS_BRIDGE_ASSETS;
    resetDocsConfigForTests();
    try {
      const service = new DocsService(logger);
      const swagger = await service.renderSwaggerUi();
      expect(swagger.length).toBeGreaterThan(0);

      const redoc = await service.renderRedoc();
      expect(redoc.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.ASSETS_DIR;
      else process.env.ASSETS_DIR = prev;
      resetDocsConfigForTests();
    }
  });
});
