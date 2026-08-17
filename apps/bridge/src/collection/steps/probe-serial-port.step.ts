import { Injectable } from '@nestjs/common';

import { isRecord } from '@repo/utils';

import { getErrorMessage } from '../../common/error-utils';
import { getDeviceCredentialResolver } from '../../monitoring/common/device-credential-resolver.service';
import type { SagaContext } from '../../saga-framework/saga.types';

interface ProbeOutcome {
  port: string | null;
  baud: unknown;
  source: string;
  confirmed: boolean;
  notes: string[];
}

interface ProbeServiceLike {
  probe(args: { deviceId: string; bmcIp: string; bmcUsername: string; bmcPassword: string }): Promise<ProbeOutcome>;
}

interface ProbeServiceFactoryLike {
  create(jobId: string, options?: { signal?: AbortSignal; workId?: string }): Promise<ProbeServiceLike>;
}

interface ProbeResultsLike {
  mergeResolvedIntoSerialPorts(deviceId: string, resolved: Record<string, unknown>): Promise<boolean>;
  enqueueDiscoveryComplete(args: { deviceId: string; jobId: string }): Promise<boolean>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

type StepResult =
  | { probed: false; reason: string }
  | { probed: true; confirmed: boolean; port: string | null; source: string };

@Injectable()
export class ProbeSerialPortStep {
  constructor(
    private readonly probeFactory: ProbeServiceFactoryLike,
    private readonly results: ProbeResultsLike,
    private readonly logger: LoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<StepResult> {
    const deviceId = String(ctx.deviceId);
    const { jobId } = ctx;

    const collectHardware = ctx.stepResults.collect_hardware;
    const collected = isRecord(collectHardware) && collectHardware['collected'] === true;
    if (!collected) {
      return { probed: false, reason: 'collection did not run' };
    }

    let confirmed = false;
    let port: string | null = null;
    let source = 'none';
    try {
      const creds = await getDeviceCredentialResolver().resolve(deviceId);
      if (creds !== null) {
        const svc = await this.probeFactory.create(jobId, { signal: ctx.signal, workId: ctx.workId });
        const r = await svc.probe({
          deviceId,
          bmcIp: creds.bmcIp,
          bmcUsername: creds.username,
          bmcPassword: creds.password,
        });
        if (r.port !== null && r.confirmed) {
          const resolved: Record<string, unknown> = {
            port: r.port,
            source: 'probed',
            confirmed: true,
            notes: r.notes,
            ...(typeof r.baud === 'number' ? { baud: r.baud } : {}),
          };
          await this.results.mergeResolvedIntoSerialPorts(deviceId, resolved);
          confirmed = true;
          port = r.port;
          source = 'probed';
          await this.logger.info(
            `Serial port probe confirmed BMC console ${r.port} (source=probed) for device ${deviceId}`,
            { jobId },
          );
        } else {
          await this.logger.info(
            `Serial port probe did not confirm a port for device ${deviceId}; relying on in-band heuristic`,
            { jobId },
          );
        }
      } else {
        await this.logger.info(`No BMC creds; relying on in-band heuristic for ${deviceId}`, { jobId });
      }
    } catch (error) {
      await this.logger.warning(`Serial port probe failed (non-fatal): ${getErrorMessage(error)}`, { jobId });
    }

    await this.results.enqueueDiscoveryComplete({ deviceId, jobId });
    return { probed: true, confirmed, port, source };
  }
}
