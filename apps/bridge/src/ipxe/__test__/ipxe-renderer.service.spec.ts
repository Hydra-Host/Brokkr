import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IpxeServiceError } from '../ipxe-errors';
import { IpxeTemplateRenderer, RETRY_SLEEP_SECONDS, type ServerTokenAtomFetcher } from '../ipxe-renderer.service';
import type { IpxeConfig } from '../ipxe.config';

const TEMPLATE_NAMES = [
  'brokkr_live.ipxe.njk',
  'disk.ipxe.njk',
  'unknown.ipxe.njk',
  'retry.ipxe.njk',
  'shell.ipxe.njk',
  'custom.ipxe.njk',
] as const;

function writeJsonEchoTemplates(dir: string): void {
  const bodies: Record<string, string> = {
    'brokkr_live.ipxe.njk':
      '{"arch":{{ arch | dump }},"platform":{{ platform | dump }},' +
      '"bridge_url":{{ bridge_url | dump }},' +
      '"environment":{{ environment | dump }},' +
      '"device_id":{{ device_id | dump }},' +
      '"discovery_initrd_id":{{ discovery_initrd_id | dump }},' +
      '"serial_port":{{ serial_port | dump }},' +
      '"job_id":{{ job_id | dump }},' +
      '"kernel_network":{{ kernel_network | dump }},' +
      '"platform_type":{{ platform_type | dump }},' +
      '"pci_realloc_off":{{ pci_realloc_off | dump }},' +
      '"flavor":{{ flavor | dump }}}',
    'disk.ipxe.njk':
      '{"platform":{{ platform | dump }},"arch":{{ arch | dump }},' +
      '"bridge_url":{{ bridge_url | dump }},"job_id":{{ job_id | dump }}}',
    'unknown.ipxe.njk': '{"buildarch":{{ buildarch | dump }},"platform":{{ platform | dump }}}',
    'retry.ipxe.njk':
      '{"bridge_url":{{ bridge_url | dump }},"sleep_seconds":{{ sleep_seconds | dump }},' +
      '"retry_count":{{ retry_count | dump }}}',
    'shell.ipxe.njk': '{"os":{{ os | dump }},"status":{{ status | dump }}}',
    'custom.ipxe.njk':
      '{"ipxe_url":{{ ipxe_url | dump }},"device_id":{{ device_id | dump }},' +
      '"brokkr_live_token":{{ brokkr_live_token | dump }},' +
      '"job_id":{{ job_id | dump }},' +
      '"phone_home_endpoint":{{ phone_home_endpoint | dump }}}',
  };
  for (const name of TEMPLATE_NAMES) {
    writeFileSync(join(dir, name), bodies[name], 'utf8');
  }
}

function makeConfig(assetsDir: string): IpxeConfig {
  return {
    bridgeUrl: 'https://bridge',
    environment: 'test',
    discoveryPlatformSlug: 'brokkr-discovery',
    finalBuildsDir: '/opt/brokkr/ipxe-builds',
    assetsDir,
  };
}

describe('IpxeTemplateRenderer', () => {
  let assetsDir: string;
  let renderer: IpxeTemplateRenderer;
  let tokenFetcher: ServerTokenAtomFetcher;
  let tokenFetcherCalls: Array<Parameters<ServerTokenAtomFetcher>[0]>;

  beforeEach(() => {
    assetsDir = mkdtempSync(join(tmpdir(), 'ipxe-renderer-test-'));
    writeJsonEchoTemplates(assetsDir);
    tokenFetcherCalls = [];
    tokenFetcher = async (req) => {
      tokenFetcherCalls.push(req);
      return {
        brokkr_live_token: 'test-live-token-from-hub',
        endpoint: 'https://hub/api/v1/bmc/phone-home',
        exp: 1_730_000_000,
      };
    };
    renderer = new IpxeTemplateRenderer(makeConfig(assetsDir), tokenFetcher);
  });

  afterEach(() => {
    rmSync(assetsDir, { recursive: true, force: true });
  });

  describe('render_discovery', () => {
    it('uses device_id for initrd key for real devices', async () => {
      const out = JSON.parse(
        await renderer.render_discovery({
          arch: 'amd64',
          platform: 'efi-amd64',
          platform_type: 'inventory',
          device_id: '12121212-1212-1212-1212-121212121212',
          serial_port: null,
          job_id: 'j',
          kernel_network: [],
          pci_realloc_off: false,
          flavor: 'full',
        }),
      );
      expect(out.discovery_initrd_id).toBe('12121212-1212-1212-1212-121212121212');
      expect(out.device_id).toBe('12121212-1212-1212-1212-121212121212');
      expect(out.bridge_url).toBe('https://bridge');
      expect(out.flavor).toBe('full');
    });

    it('passes the light flavor through to the template', async () => {
      const out = JSON.parse(
        await renderer.render_discovery({
          arch: 'arm64',
          platform: 'efi-arm64',
          platform_type: 'inventory',
          device_id: '12121212-1212-1212-1212-121212121212',
          serial_port: null,
          job_id: 'j',
          kernel_network: [],
          pci_realloc_off: false,
          flavor: 'light',
        }),
      );
      expect(out.flavor).toBe('light');
    });

    it('placeholder uses mac-keyed initrd', async () => {
      const out = JSON.parse(
        await renderer.render_discovery({
          arch: 'amd64',
          platform: 'efi-amd64',
          platform_type: 'inventory',
          device_id: '34343434-3434-3434-3434-343434343434',
          serial_port: null,
          job_id: 'j',
          kernel_network: [],
          pci_realloc_off: false,
          flavor: 'full',
          mac: 'AA:BB:CC:DD:EE:FF',
          is_placeholder_device: true,
        }),
      );
      expect(out.discovery_initrd_id).toBe('mac-aabbccddeeff');
    });
  });

  describe('render_disk', () => {
    it('renders disk template with expected vars', async () => {
      const out = JSON.parse(await renderer.render_disk({ platform: 'efi-amd64', arch: 'amd64', job_id: 'j' }));
      expect(out).toEqual({
        platform: 'efi-amd64',
        arch: 'amd64',
        bridge_url: 'https://bridge',
        job_id: 'j',
      });
    });
  });

  describe('render_shell and render_unknown', () => {
    it('render_shell forwards operating_system as os and status', async () => {
      const out = JSON.parse(await renderer.render_shell({ operating_system: 'Ubuntu', status: 'failed' }));
      expect(out).toEqual({ os: 'Ubuntu', status: 'failed' });
    });

    it('render_unknown forwards buildarch and platform', async () => {
      const out = JSON.parse(await renderer.render_unknown({ buildarch: 'ppc64', platform: 'efi' }));
      expect(out).toEqual({ buildarch: 'ppc64', platform: 'efi' });
    });
  });

  describe('render_retry', () => {
    it('uses default sleep and retry_count when not given', async () => {
      const out = JSON.parse(await renderer.render_retry());
      expect(out).toEqual({ bridge_url: 'https://bridge', sleep_seconds: RETRY_SLEEP_SECONDS, retry_count: 1 });
    });

    it('honors explicit sleep_seconds', async () => {
      const out = JSON.parse(await renderer.render_retry({ sleep_seconds: 12 }));
      expect(out.sleep_seconds).toBe(12);
    });

    it('embeds the incremented retry_count for the bounded re-chain', async () => {
      const out = JSON.parse(await renderer.render_retry({ retry_count: 4 }));
      expect(out.retry_count).toBe(4);
    });
  });

  describe('render_custom', () => {
    it('pulls bearer token and endpoint from server_token atom', async () => {
      const out = JSON.parse(
        await renderer.render_custom({
          ipxe_url: 'https://custom.test/script.ipxe',
          device_id: '12345678-1234-1234-1234-123456789abc',
          job_id: 'job-x',
        }),
      );
      expect(tokenFetcherCalls).toHaveLength(1);
      expect(tokenFetcherCalls[0]).toEqual({
        domain: 'server_token',
        entityId: '12345678-1234-1234-1234-123456789abc',
        atomKey: 'device:12345678-1234-1234-1234-123456789abc:server_token',
        jobId: 'job-x',
      });
      expect(out.brokkr_live_token).toBe('test-live-token-from-hub');
      expect(out.phone_home_endpoint).toBe('https://hub/api/v1/bmc/phone-home');
    });

    it('synthesizes ipxe-<device> job id when missing', async () => {
      const out = JSON.parse(
        await renderer.render_custom({
          ipxe_url: 'https://custom.test/script.ipxe',
          device_id: 'abcdef00-0000-0000-0000-000000000456',
        }),
      );
      expect(out.job_id).toBe('ipxe-abcdef00-0000-0000-0000-000000000456');
      expect(tokenFetcherCalls[0]?.jobId).toBe('ipxe-abcdef00-0000-0000-0000-000000000456');
    });

    it('raises iPXEServiceError when server_token atom is missing', async () => {
      const missingFetcher: ServerTokenAtomFetcher = async () => null;
      const rendererMissing = new IpxeTemplateRenderer(makeConfig(assetsDir), missingFetcher);
      await expect(
        rendererMissing.render_custom({
          ipxe_url: 'https://custom.test/script.ipxe',
          device_id: 'abcdef00-0000-0000-0000-000000000456',
          job_id: 'job-y',
        }),
      ).rejects.toMatchObject({
        name: 'iPXEServiceError',
        message: expect.stringContaining(
          'server_token atom unavailable for device abcdef00-0000-0000-0000-000000000456',
        ),
      });
      try {
        await rendererMissing.render_custom({
          ipxe_url: 'https://custom.test/script.ipxe',
          device_id: 'abcdef00-0000-0000-0000-000000000456',
        });
      } catch (e) {
        expect(e).toBeInstanceOf(IpxeServiceError);
      }
    });
  });
});
