// Connectivity comes solely from the gRPC connection registry — no env short-circuit; a mocked "connected" deadlocks reprovision.

import { Injectable } from '@nestjs/common';

import { ConnectionRegistry } from '../agent/connection-registry/connection-registry.service';
import { ContextLogger } from '../logger/logger.service';

export interface BrokkrLiveServiceLogger {
  debug(message: string, context?: { jobId?: string }): Promise<void>;
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

export interface BrokkrLiveConnectionRegistry {
  isConnected(deviceId: string): boolean;
}

export interface ConnectivityResult {
  connected: boolean;
  errorMessage: string | null;
}

export class BrokkrLiveServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokkrLiveServiceError';
  }
}

export class BrokkrLiveService {
  constructor(
    public readonly jobId: string,
    private readonly registry: BrokkrLiveConnectionRegistry,
    private readonly logger: BrokkrLiveServiceLogger,
  ) {}

  async testDeviceConnectivity(deviceId: string | number): Promise<ConnectivityResult> {
    const deviceIdStr = String(deviceId);
    try {
      await this.logger.debug(`Starting connectivity test for device: ${deviceIdStr}`, {
        jobId: this.jobId,
      });
      await this.logger.info(`Testing Brokkr Live connectivity for device: ${deviceIdStr}`, {
        jobId: this.jobId,
      });

      const connected = this.registry.isConnected(deviceIdStr);
      if (connected) {
        await this.logger.info(`Brokkr Live agent connected for device ${deviceIdStr}`, {
          jobId: this.jobId,
        });
      } else {
        await this.logger.warning(`Brokkr Live agent NOT connected for device ${deviceIdStr}`, {
          jobId: this.jobId,
        });
      }
      return {
        connected,
        errorMessage: connected ? null : 'agent not in connection map',
      };
    } catch (error) {
      if (error instanceof BrokkrLiveServiceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      await this.logger.error(`Unexpected error testing connectivity: ${message}`, {
        jobId: this.jobId,
      });
      throw new BrokkrLiveServiceError(`Connectivity test failed: ${message}`);
    }
  }
}

@Injectable()
export class BrokkrLiveServiceFactory {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly logger: ContextLogger,
  ) {}

  async create(jobId: string = ''): Promise<BrokkrLiveService> {
    return new BrokkrLiveService(jobId, this.registry, this.logger);
  }
}
