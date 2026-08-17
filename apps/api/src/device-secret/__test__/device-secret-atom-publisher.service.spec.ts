import { Test, TestingModule } from '@nestjs/testing';
import { DeviceSecretActorType, DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import { ConfigAtomWriter, TTL_DEVICE_SECRET_SECONDS, deviceSecret } from 'src/common/redis';
import { Mock, vi } from 'vitest';
import { DeviceSecretAtomPublisher } from '../device-secret-atom-publisher.service';
import { DeviceSecretAtomSchema } from '../device-secret-atom.schema';
import type { SealedSecretEnvelope } from '../device-secret.service';
import { DeviceSecretService } from '../device-secret.service';

const DEVICE_UUID = '11111111-2222-3333-4444-555555555555';
const ZONE_UUID = '22222222-3333-4444-5555-666666666666';
const KEY_UUID = '33333333-4444-5555-6666-777777777777';
const REQUEST_UUID = '44444444-5555-6666-7777-888888888888';
const BRIDGE_ACTOR = { type: DeviceSecretActorType.BRIDGE, id: 'bridge-a' };

function sealedFixture(overrides: Partial<SealedSecretEnvelope> = {}): SealedSecretEnvelope {
  return {
    zoneId: ZONE_UUID,
    zoneKeyId: KEY_UUID,
    deviceId: DEVICE_UUID,
    purpose: DeviceSecretPurpose.BMC,
    kind: DeviceSecretKind.USER,
    keyGen: 3,
    ephPub: Buffer.from('eph-pub-bytes').toString('base64'),
    ciphertext: Buffer.from('sealed-user-pass').toString('base64'),
    tag: Buffer.from('auth-tag-bytes16').toString('base64'),
    ...overrides,
  };
}

describe('DeviceSecretAtomPublisher', () => {
  let service: DeviceSecretAtomPublisher;
  let getCurrentSealedByKind: Mock;
  let writeAtomJson: Mock;

  beforeEach(async () => {
    getCurrentSealedByKind = vi.fn();
    writeAtomJson = vi.fn().mockResolvedValue({ written: true });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceSecretAtomPublisher,
        { provide: DeviceSecretService, useValue: { getCurrentSealedByKind } },
        { provide: ConfigAtomWriter, useValue: { writeAtomJson } },
        {
          provide: `LoggerService${DeviceSecretAtomPublisher.name}`,
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    service = module.get(DeviceSecretAtomPublisher);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('publishes the sealed blob as an envelope under the zone prefix + per-kind key (no TTL)', async () => {
    const sealed = sealedFixture();
    getCurrentSealedByKind.mockResolvedValueOnce(sealed);

    const result = await service.publishCurrent(
      DEVICE_UUID,
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      BRIDGE_ACTOR,
      {
        requestId: REQUEST_UUID,
      },
    );

    expect(result).toEqual({ written: true });
    expect(getCurrentSealedByKind).toHaveBeenCalledWith(
      DEVICE_UUID,
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      BRIDGE_ACTOR,
    );
    expect(writeAtomJson).toHaveBeenCalledWith(
      ZONE_UUID,
      deviceSecret(DEVICE_UUID, DeviceSecretPurpose.BMC, DeviceSecretKind.USER),
      {
        zoneId: ZONE_UUID,
        zoneKeyId: KEY_UUID,
        deviceId: DEVICE_UUID,
        purpose: DeviceSecretPurpose.BMC,
        kind: DeviceSecretKind.USER,
        keyGen: 3,
        ephPub: sealed.ephPub,
        ciphertext: sealed.ciphertext,
        tag: sealed.tag,
      },
      DeviceSecretAtomSchema,
      TTL_DEVICE_SECRET_SECONDS,
      { request_id: REQUEST_UUID },
    );
  });

  it('keys the atom under device/secrets/purpose/kind, all lowercased', () => {
    expect(deviceSecret(DEVICE_UUID, DeviceSecretPurpose.BMC, DeviceSecretKind.USER)).toBe(
      `device:${DEVICE_UUID}:secrets:bmc:user`,
    );
  });

  it('publishes only the SEALED ciphertext + binding metadata — never the decrypted credential', async () => {
    getCurrentSealedByKind.mockResolvedValueOnce(sealedFixture());
    await service.publishCurrent(DEVICE_UUID, DeviceSecretPurpose.BMC, DeviceSecretKind.USER, BRIDGE_ACTOR);

    const writtenValue = DeviceSecretAtomSchema.parse(writeAtomJson.mock.calls[0][2]);
    expect(Object.keys(writtenValue).sort()).toEqual(
      ['ciphertext', 'deviceId', 'ephPub', 'keyGen', 'kind', 'purpose', 'tag', 'zoneId', 'zoneKeyId'].sort(),
    );
    expect(writtenValue).not.toHaveProperty('user');
    expect(writtenValue).not.toHaveProperty('pass');
    expect(writtenValue).not.toHaveProperty('secret');
    expect(writtenValue.ciphertext).toBe(sealedFixture().ciphertext);
  });

  it('does NOT publish when no live/openable secret exists (absent or invalidated)', async () => {
    getCurrentSealedByKind.mockResolvedValueOnce(null);

    const result = await service.publishCurrent(
      DEVICE_UUID,
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      BRIDGE_ACTOR,
    );

    expect(result).toEqual({ written: false, reason: 'no-secret' });
    expect(writeAtomJson).not.toHaveBeenCalled();
  });

  it('passes request_id null when no requestId is supplied', async () => {
    getCurrentSealedByKind.mockResolvedValueOnce(sealedFixture());
    await service.publishCurrent(DEVICE_UUID, DeviceSecretPurpose.BMC, DeviceSecretKind.USER, BRIDGE_ACTOR);
    expect(writeAtomJson.mock.calls[0][5]).toEqual({ request_id: null });
  });

  it('surfaces a stale write result (no throw) when a newer atom won the race', async () => {
    getCurrentSealedByKind.mockResolvedValueOnce(sealedFixture());
    writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });

    await expect(
      service.publishCurrent(DEVICE_UUID, DeviceSecretPurpose.BMC, DeviceSecretKind.USER, BRIDGE_ACTOR),
    ).resolves.toEqual({ written: false, reason: 'stale' });
  });

  it('fails closed if the resolved blob is malformed (schema mismatch) before any Redis write', async () => {
    getCurrentSealedByKind.mockResolvedValueOnce(sealedFixture({ ephPub: 'not valid base64 !!!' }));

    await expect(
      service.publishCurrent(DEVICE_UUID, DeviceSecretPurpose.BMC, DeviceSecretKind.USER, BRIDGE_ACTOR),
    ).rejects.toThrow();
    expect(writeAtomJson).not.toHaveBeenCalled();
  });
});
