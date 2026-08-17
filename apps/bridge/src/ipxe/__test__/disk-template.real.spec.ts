import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IpxeTemplateRenderer } from '../ipxe-renderer.service';
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

describe('disk.ipxe.njk (real template) — PXE-04 grub gating', () => {
  it('emits the grub chain for a supported pair (amd64:efi)', async () => {
    const out = await realRenderer().render_disk({
      platform: 'efi',
      arch: 'amd64',
      job_id: 'j',
      grub_supported: true,
    });
    expect(out).toContain('/api/grub?platform=efi&arch=amd64');
    expect(out).toContain('set bootload_url "https://bridge.example/api/grub?platform=efi&arch=amd64"');
  });

  it('skips the grub chain and sanboots directly for an unsupported pair (arm64:pcbios)', async () => {
    const out = await realRenderer().render_disk({
      platform: 'pcbios',
      arch: 'arm64',
      job_id: 'j',
      grub_supported: false,
    });
    expect(out).not.toContain('/api/grub');
    expect(out).not.toContain('set bootload_url');
    expect(out).toContain('booting local disk directly');
    expect(out).toContain('sanboot');
  });
});
