import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../saga-framework/saga.types';
import type { IPMIDevice } from '../ipmi/device';
import type { ChannelAccessOutcome } from '../ipmi/rmcp-plus';
import { validateIp, validateUsername } from '../ipmi/validation.js';
import { credsFromContext } from './power-control-context';

interface IPMIDeviceFactoryLike {
  create(args: { ip: string; username: string; password: string; port: number; jobId: string }): IPMIDevice;
}

interface LanplusRepairLike {
  repair(device: IPMIDevice, opts: { channel: number }): Promise<ChannelAccessOutcome>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

type StepResult =
  | { skipped: true; reason: string | null }
  | {
      repaired: true;
      channel: number;
      uid: number | null;
      reasons: string[];
      action: string | null;
    };

function toInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(`Cannot convert ${String(value)} to integer`);
  }
  return Math.trunc(n);
}

@Injectable()
export class EnsureLanplusAccessStep {
  constructor(
    private readonly deviceFactory: IPMIDeviceFactoryLike,
    private readonly repair: LanplusRepairLike,
    private readonly logger: LoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<StepResult> {
    const { payload, jobId } = ctx;

    const creds = credsFromContext(ctx);

    const device = this.deviceFactory.create({
      ip: validateIp(creds.bmcIp),
      username: validateUsername(creds.username),
      password: creds.password,
      port: toInt(payload['port'] ?? 623),
      jobId,
    });
    const channel = toInt(payload['ipmi_channel'] ?? 1);
    const outcome = await this.repair.repair(device, { channel });

    if (outcome.lanplusOk && !outcome.blocked) {
      return { skipped: true, reason: 'lanplus already functional' };
    }

    if (outcome.repaired) {
      const uidStr = outcome.uid == null ? null : String(outcome.uid);
      await this.logger.info(
        `Repaired channel ${outcome.channel} access for uid ${uidStr}: ${outcome.reasons.join('; ')}`,
        { jobId },
      );
      return {
        repaired: true,
        channel: outcome.channel,
        uid: outcome.uid,
        reasons: outcome.reasons,
        action: outcome.action,
      };
    }

    if (outcome.blocked && outcome.repaired === false) {
      const errStr = outcome.error === null ? null : outcome.error;
      throw new Error(`lanplus blocked by channel ${outcome.channel} access and repair failed: ${errStr}`);
    }

    const errStr = outcome.error === null ? null : outcome.error;
    await this.logger.warning(`lanplus access not repaired (${errStr}); deferring to validate_ipmi`, { jobId });
    return { skipped: true, reason: outcome.error };
  }
}
