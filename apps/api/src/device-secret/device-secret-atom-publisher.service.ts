import { Injectable } from '@nestjs/common';
import { DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { ConfigAtomWriter, TTL_DEVICE_SECRET_SECONDS, deviceSecret, type AtomWriteResult } from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import { DeviceSecretAtomSchema, type DeviceSecretAtom } from './device-secret-atom.schema';
import { type DeviceSecretActor } from './device-secret-audit.service';
import { DeviceSecretService } from './device-secret.service';

export type DeviceSecretAtomWriteResult = { written: boolean; reason?: 'no-secret' | 'stale' };

@Injectable()
export class DeviceSecretAtomPublisher {
  constructor(
    private readonly deviceSecretService: DeviceSecretService,
    private readonly atomWriter: ConfigAtomWriter,
    @Logger(DeviceSecretAtomPublisher.name) private readonly logger: LoggerService,
  ) {}

  async publishCurrent(
    deviceId: string,
    purpose: DeviceSecretPurpose,
    kind: DeviceSecretKind,
    actor: DeviceSecretActor,
    opts: { requestId?: string | null } = {},
  ): Promise<DeviceSecretAtomWriteResult> {
    const sealed = await this.deviceSecretService.getCurrentSealedByKind(deviceId, purpose, kind, actor);
    if (sealed === null) {
      this.logger.log(
        `Skipping sealed-secret atom publish for device ${deviceId} ${purpose}/${kind}: ` +
          `no live, openable secret (none written or invalidated by a zone re-key)`,
      );
      return { written: false, reason: 'no-secret' };
    }

    const value: DeviceSecretAtom = DeviceSecretAtomSchema.parse({
      zoneId: sealed.zoneId,
      zoneKeyId: sealed.zoneKeyId,
      deviceId: sealed.deviceId,
      purpose: sealed.purpose,
      kind: sealed.kind,
      keyGen: sealed.keyGen,
      ephPub: sealed.ephPub,
      ciphertext: sealed.ciphertext,
      tag: sealed.tag,
    });

    const key = deviceSecret(deviceId, purpose, kind);
    const result: AtomWriteResult = await this.atomWriter.writeAtomJson(
      sealed.zoneId,
      key,
      value,
      DeviceSecretAtomSchema,
      TTL_DEVICE_SECRET_SECONDS,
      { request_id: opts.requestId ?? null },
    );
    if (!result.written) {
      this.logger.warn(
        `Skipped sealed-secret atom write (${result.reason ?? 'not-written'}) for device ${deviceId} ` +
          `${purpose}/${kind} (key=${key}) — a newer atom won`,
      );
      return { written: false, reason: result.reason };
    }
    this.logger.log(
      `Published sealed-secret atom for device ${deviceId} ${purpose}/${kind} ` +
        `(key=${key}, zone=${sealed.zoneId}, keyGen=${sealed.keyGen})`,
    );
    return { written: true };
  }
}
