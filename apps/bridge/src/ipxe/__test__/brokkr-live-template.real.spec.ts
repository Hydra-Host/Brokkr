import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IpxeTemplateRenderer, type RenderDiscoveryArgs } from '../ipxe-renderer.service';
import type { IpxeConfig } from '../ipxe.config';

const REAL_ASSETS_DIR = join(process.cwd(), 'assets', 'ipxe');

function realRenderer(): IpxeTemplateRenderer {
  const config: IpxeConfig = {
    bridgeUrl: 'https://bridge.example',
    environment: 'test',
    discoveryPlatformSlug: 'brokkr-discovery',
    finalBuildsDir: '/opt/brokkr/ipxe-builds',
    assetsDir: REAL_ASSETS_DIR,
  };
  return new IpxeTemplateRenderer(config, async () => null);
}

function args(overrides: Partial<RenderDiscoveryArgs> = {}): RenderDiscoveryArgs {
  return {
    arch: 'amd64',
    platform: 'efi',
    platform_type: 'inventory',
    device_id: '12121212-1212-1212-1212-121212121212',
    serial_port: null,
    job_id: 'j',
    kernel_network: [],
    pci_realloc_off: false,
    flavor: 'full',
    ...overrides,
  };
}

describe('brokkr_live.ipxe.njk (real template) — flavor in every discovery url', () => {
  it('points the kernel, iso and initrd at the light tree for the light flavor', async () => {
    const out = await realRenderer().render_discovery(args({ flavor: 'light' }));

    expect(out).toContain('kernel https://bridge.example/api/discovery/light/amd64/vmlinuz##params');
    expect(out).toContain('url=https://bridge.example/api/discovery/light/amd64/brokkr-discovery.iso');
    expect(out).toContain('initrd https://bridge.example/api/discovery/light/amd64/initrd.img##params');
    expect(out).not.toMatch(/api\/discovery\/amd64\//);
  });

  it('points every discovery url at the full tree for the full flavor', async () => {
    const out = await realRenderer().render_discovery(args({ flavor: 'full', arch: 'arm64' }));

    const discoveryUrls = out.match(/https:\/\/bridge\.example\/api\/discovery\/[^\s#]+/g) ?? [];
    expect(discoveryUrls).toHaveLength(3);
    for (const url of discoveryUrls) {
      expect(url).toMatch(/^https:\/\/bridge\.example\/api\/discovery\/full\/arm64\//);
    }
  });
});
