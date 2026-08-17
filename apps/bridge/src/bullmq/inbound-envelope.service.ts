import { Injectable } from '@nestjs/common';
import { isRecord } from '@repo/utils';
import { getErrorMessage } from '../common/error-utils';

import { SealKeyUnknownError, SealOpenError } from '../zone-crypto/auth-dh.types';
import { SealedEnvelopeService } from '../zone-crypto/sealed-envelope.service';
import { REASON_KEY_UNKNOWN, REASON_TAMPER, type ExpectedRouting } from '../zone-crypto/sealed-envelope.types';
import { ZoneCryptoService } from '../zone-crypto/zone-crypto.service';

import { openBridgeLocalJob } from './bridge-local-sig';
import { PlaintextAfterActivationError } from './bullmq.types';
import type { InboundEnvelopeOpener, ProcessableJob } from './handlers.service';

export interface ZoneIdProvider {
  getZoneId(): string;
}

export interface InboundEnvelopeLogger {
  error(message: string): Promise<void>;
}

@Injectable()
export class InboundEnvelopeOpenerService implements InboundEnvelopeOpener {
  constructor(
    private readonly sealedEnvelope: SealedEnvelopeService,
    private readonly zoneCrypto: ZoneCryptoService,
    private readonly zoneIdProvider: ZoneIdProvider,
    private readonly logger: InboundEnvelopeLogger,
    private readonly intraBridgeQueueName: string,
  ) {}

  async open(job: ProcessableJob<unknown>): Promise<{ payload: unknown; createdAtMs: number; isBridgeLocal: boolean }> {
    const envelope = isRecord(job.data) && 'envelope_v' in job.data ? job.data : null;
    const isBridgeLocal = isRecord(job.data) && job.data.__bridge_local === true;

    if (envelope !== null) {
      const expectedRouting: ExpectedRouting = {
        zoneId: this.zoneIdProvider.getZoneId(),
        queueName: job.queue.name,
      };
      let plaintext: Buffer;
      try {
        plaintext = this.sealedEnvelope.openHubToBridge(envelope, expectedRouting);
      } catch (exc) {
        if (exc instanceof SealKeyUnknownError) {
          const reason = exc.reason || REASON_KEY_UNKNOWN;
          await this.logger.error(`zone_crypto envelope rejected (reason=${reason}): ${getErrorMessage(exc)}`);
          throw exc;
        }
        if (exc instanceof SealOpenError) {
          const reason = exc.reason || REASON_TAMPER;
          await this.logger.error(`zone_crypto envelope rejected (reason=${reason}): ${getErrorMessage(exc)}`);
          throw exc;
        }
        throw exc;
      }
      const aad = envelope.aad;
      const createdAtMs = isRecord(aad) ? aad.created_at : null;
      if (typeof createdAtMs !== 'number' || !Number.isInteger(createdAtMs)) {
        throw new TypeError('Opened envelope has an invalid AAD created_at');
      }

      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const decoded = decoder.decode(plaintext);
        return { payload: JSON.parse(decoded) as unknown, createdAtMs, isBridgeLocal: false };
      } catch (exc) {
        await this.logger.error(
          `zone_crypto envelope plaintext invalid (reason=malformed_payload): ${getErrorMessage(exc)}`,
        );
        throw exc;
      }
    }

    const zone = this.zoneCrypto.get();
    let createdAtMs = Date.now();
    if (isBridgeLocal && zone !== null && isRecord(job.data)) {
      try {
        const payload = openBridgeLocalJob(zone.zonePriv, job.data, {
          job_id: job.id ?? '',
          job_name: job.name,
          queue_name: job.queue.name,
        });
        createdAtMs = Number(job.data.__bridge_local_ts) * 1_000;
        return { payload, createdAtMs, isBridgeLocal: true };
      } catch (error) {
        await this.logger.error(`bridge-local signature rejected: ${getErrorMessage(error)}`);
        throw error;
      }
    }

    if (zone !== null && job.queue.name !== this.intraBridgeQueueName && !isBridgeLocal) {
      await this.logger.error(
        'zone_crypto plaintext rejected (reason=plaintext_after_activation): ' +
          `zone is activated but inbound payload on queue '${job.queue.name}' is plaintext`,
      );
      throw new PlaintextAfterActivationError(`plaintext_after_activation: queue=${job.queue.name}, name=${job.name}`);
    }

    // No dict coercion — non-dict payloads propagate so downstream access crashes rather than seeing `{}`.
    return { payload: job.data, createdAtMs, isBridgeLocal };
  }
}
