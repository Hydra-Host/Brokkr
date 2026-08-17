import { create } from '@bufbuild/protobuf';

import { getErrorMessage } from '../errors';
import { RenewTokenRequestSchema } from '../gen/brokkr/agent/v1/agent_pb';
import { makeLogger } from '../logger';
import { hashDeviceId } from './hash';
import type { TransportPool } from './pool';

const logger = makeLogger('token-renewer');

export interface TokenRenewerOptions {
  deviceId: string;
  pool: TransportPool;
  intervalMs: number;
}

export class TokenRenewer {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: TokenRenewerOptions) {}

  start(): void {
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        await this.renewOnce();
      } catch (err) {
        logger.warn('token renew tick threw', { err: getErrorMessage(err) });
      } finally {
        this.schedule();
      }
    }, this.opts.intervalMs);
    this.timer.unref();
  }

  private async renewOnce(): Promise<void> {
    const addresses = [...this.opts.pool.listAddresses()].sort();
    if (addresses.length === 0) {
      logger.debug('token renew skipped: pool has no live sessions');
      return;
    }

    const startIdx = hashDeviceId(this.opts.deviceId) % addresses.length;
    const request = create(RenewTokenRequestSchema, {});

    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[(startIdx + i) % addresses.length]!;
      try {
        const ack = await this.opts.pool.getClient(address).renewToken(request);
        logger.debug('token renewed', {
          address,
          new_expires_in_s: ack.newExpiresInS,
        });
        return;
      } catch (err) {
        logger.warn('token renew failed on bridge, trying next', {
          address,
          err: getErrorMessage(err),
        });
      }
    }
    logger.warn('token renew failed on every bridge', {
      attempted: addresses.length,
    });
  }
}
