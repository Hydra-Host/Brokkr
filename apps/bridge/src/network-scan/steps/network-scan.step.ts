import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage } from '../../common/error-utils';

import { NetworkScanService } from '../../bridge-network/network-scan.service';
import type { SagaContext } from '../../saga-framework/saga.types';

interface ScanNetworkResult {
  results?: Record<string, unknown>;
  errored?: boolean;
}

export interface NetworkScanServiceLike {
  scanNetworks(subnets: string[]): Promise<Record<string, ScanNetworkResult>>;
}

export interface NetworkScanServiceFactoryLike {
  create(opts: { jobId: string }): NetworkScanServiceLike | Promise<NetworkScanServiceLike>;
}

@Injectable()
export class NetworkScanServiceFactory implements NetworkScanServiceFactoryLike {
  create(opts: { jobId: string }): NetworkScanService {
    return new NetworkScanService(opts.jobId);
  }
}

interface NetworkScanStepResult {
  success: boolean;
  error?: string;
  subnets_scanned?: number;
  devices_discovered?: number;
  results?: Record<string, ScanNetworkResult>;
}

@Injectable()
export class NetworkScanStep {
  private readonly logger = new Logger('step-network-scan');

  constructor(private readonly factory: NetworkScanServiceFactory) {}

  async execute(ctx: SagaContext): Promise<NetworkScanStepResult> {
    const subnet = (ctx.payload['subnet'] as string | undefined) ?? '';
    if (!subnet) {
      return { success: false, error: 'No subnet provided' };
    }
    const subnets = [subnet];

    try {
      this.logger.log(`Starting network scan for ${subnets.length} subnet(s) job=${ctx.jobId}`);

      const service = await this.factory.create({ jobId: ctx.jobId });
      const results = await service.scanNetworks(subnets);

      let deviceCount = 0;
      for (const net of Object.values(results)) {
        if (!net.errored) {
          const nested = 'results' in net ? net.results : {};
          deviceCount += Object.keys(nested ?? {}).length;
        }
      }
      this.logger.log(`Network scan completed: ${deviceCount} devices discovered job=${ctx.jobId}`);

      return {
        success: true,
        subnets_scanned: subnets.length,
        devices_discovered: deviceCount,
        results,
      };
    } catch (error) {
      this.logger.error(`Network scan failed: ${getErrorMessage(error)} job=${ctx.jobId}`);
      throw error;
    }
  }
}
