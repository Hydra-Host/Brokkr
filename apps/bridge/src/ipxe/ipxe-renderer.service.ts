import * as nunjucks from 'nunjucks';

import { deviceDeployToken } from '../common/redis/redis-keys';
import type { AtomFetchRequest } from '../device-record/atom/atom-fetcher';
import type { DeployTokenAtom } from '../device-record/atom/deploy-token.schema';
import type { DiscoveryFlavor } from '../download/discovery.config';
import { logDebug } from '../logger/logger.service';

import { IpxeDeployTokenUnavailableError, IpxeServiceError } from './ipxe-errors';
import { normalizeMacForInitrd } from './ipxe-renderer.helpers';
import type { IpxeConfig } from './ipxe.config';

export const RETRY_SLEEP_SECONDS = 5;

// eslint-disable-next-line no-control-regex -- deliberate: match C0 control chars + DEL
const CONTROL_CHAR_RE = new RegExp('[\\u0000-\\u001f\\u007f]');

export type DeployTokenAtomRequest = AtomFetchRequest<'deploy_token'>;

export type DeployTokenAtomFetcher = (request: DeployTokenAtomRequest) => Promise<DeployTokenAtom | null>;

export interface RenderDiscoveryArgs {
  arch: string;
  platform: string;
  platform_type: string;
  device_id: string;
  serial_port: string | null;
  serial_baud?: number | null;
  job_id: string;
  kernel_network: ReadonlyArray<string>;
  pci_realloc_off: boolean;
  flavor: DiscoveryFlavor;
  mac?: string;
  is_placeholder_device?: boolean;
}

export interface RenderDiskArgs {
  platform: string;
  arch: string;
  job_id?: string;
  grub_supported?: boolean;
}

export interface RenderUnknownArgs {
  buildarch: string;
  platform: string;
}

export interface RenderRetryArgs {
  sleep_seconds?: number;
  retry_count?: number;
}

export interface RenderShellArgs {
  operating_system: string;
  status: string;
}

export interface RenderCustomArgs {
  ipxe_url: string;
  device_id: string;
  job_id?: string;
}

export class IpxeTemplateRenderer {
  private readonly env: nunjucks.Environment;

  constructor(
    private readonly config: IpxeConfig,
    private readonly getDeployTokenAtom: DeployTokenAtomFetcher,
  ) {
    this.env = new nunjucks.Environment(new nunjucks.FileSystemLoader(config.assetsDir), {
      autoescape: false,
    });
  }

  render_discovery(args: RenderDiscoveryArgs): Promise<string> {
    const mac = args.mac ?? '';
    const isPlaceholder = args.is_placeholder_device ?? false;
    const discoveryInitrdId = isPlaceholder && mac ? `mac-${normalizeMacForInitrd(mac)}` : args.device_id;

    return this.renderTemplate('brokkr_live.ipxe.njk', {
      arch: args.arch,
      platform: args.platform,
      bridge_url: this.config.bridgeUrl,
      environment: this.config.environment,
      device_id: args.device_id,
      discovery_initrd_id: discoveryInitrdId,
      serial_port: args.serial_port,
      serial_baud: args.serial_baud ?? 115200,
      job_id: args.job_id,
      kernel_network: args.kernel_network ?? [],
      platform_type: args.platform_type,
      pci_realloc_off: args.pci_realloc_off,
      flavor: args.flavor,
    });
  }

  render_disk(args: RenderDiskArgs): Promise<string> {
    return this.renderTemplate('disk.ipxe.njk', {
      platform: args.platform,
      arch: args.arch,
      bridge_url: this.config.bridgeUrl,
      job_id: args.job_id ?? '',
      grub_supported: args.grub_supported ?? true,
    });
  }

  render_unknown(args: RenderUnknownArgs): Promise<string> {
    return this.renderTemplate('unknown.ipxe.njk', {
      buildarch: args.buildarch,
      platform: args.platform,
    });
  }

  render_retry(args: RenderRetryArgs = {}): Promise<string> {
    return this.renderTemplate('retry.ipxe.njk', {
      bridge_url: this.config.bridgeUrl,
      sleep_seconds: args.sleep_seconds ?? RETRY_SLEEP_SECONDS,
      retry_count: args.retry_count ?? 1,
    });
  }

  render_shell(args: RenderShellArgs): Promise<string> {
    return this.renderTemplate('shell.ipxe.njk', {
      os: args.operating_system,
      status: args.status,
    });
  }

  async render_custom(args: RenderCustomArgs): Promise<string> {
    const jobId = args.job_id ?? '';
    const effectiveJobId = jobId || `ipxe-${args.device_id}`;

    const token = await this.getDeployTokenAtom({
      domain: 'deploy_token',
      entityId: args.device_id,
      atomKey: deviceDeployToken(args.device_id),
      jobId: effectiveJobId,
    });
    if (token === null) {
      throw new IpxeDeployTokenUnavailableError(
        `deploy_token atom unavailable for device ${args.device_id} (hub render request timed out or returned negative-cache)`,
      );
    }

    for (const [field, value] of [
      ['ipxe_url', args.ipxe_url],
      ['phone_home_endpoint', token.endpoint],
      ['deployment_os_token', token.deployment_os_token],
    ] as const) {
      if (CONTROL_CHAR_RE.test(value)) {
        throw new IpxeServiceError(`custom iPXE ${field} contains control characters; refusing to render`);
      }
    }

    await logDebug('iPXE phone home creds resolved from hub atom', {
      jobId: effectiveJobId,
    });

    return this.renderTemplate('custom.ipxe.njk', {
      ipxe_url: args.ipxe_url,
      device_id: args.device_id,
      deployment_os_token: token.deployment_os_token,
      job_id: effectiveJobId,
      phone_home_endpoint: token.endpoint,
    });
  }

  private renderTemplate(name: string, ctx: Record<string, unknown>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.env.render(name, ctx, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result ?? '');
      });
    });
  }
}
