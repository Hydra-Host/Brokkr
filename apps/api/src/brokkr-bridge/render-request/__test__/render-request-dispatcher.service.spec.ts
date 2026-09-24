import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DeviceSecretActorType, DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import {
  ConfigAtomWriter,
  NETPLAN_LIVE_TTL_SECONDS,
  TTL_NEGATIVE_CACHE_SECONDS,
  deployToken,
  deviceSecret,
  netplanConfig,
  serverToken,
} from 'src/common/redis';
import { DeviceSecretAtomPublisher } from 'src/device-secret/device-secret-atom-publisher.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DeviceContextService } from '../../device-context.service';
import { DeviceRecordPublisher } from '../../device-record/device-record-publisher.service';
import { DeviceResolverService } from '../../device-record/device-resolver.service';
import { NetplanAtomSchema } from '../../netplan/netplan-atom.schema';
import { NetplanPublisherService } from '../../netplan/netplan-publisher.service';
import { ServerTokenService } from '../../server-token/server-token.service';
import type { RenderRequest } from '../../types/render-request.types';
import { RenderRequestDispatcher } from '../render-request-dispatcher.service';

const BASE = {
  request_id: '11111111-1111-1111-1111-111111111111',
  zone_id: '22222222-2222-2222-2222-222222222222',
  bridge_id: 'bridge-a',
} as const;

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';

describe('RenderRequestDispatcher', () => {
  let dispatcher: RenderRequestDispatcher;
  let mintForCtx: Mock;
  let writeAtomForCtx: Mock;
  let mintDeployForCtx: Mock;
  let writeDeployAtomForCtx: Mock;
  let resolveZoneContext: Mock;
  let deviceFindUnique: Mock;
  let writeRecordForDevice: Mock;
  let writePlaceholder: Mock;
  let resolverResolve: Mock;
  let renderLiveNetplan: Mock;
  let publishDeviceSecret: Mock;
  let writeAtomJson: Mock;
  let writeAtomError: Mock;
  let loggerLog: Mock;
  let loggerWarn: Mock;

  const makeCtx = (zoneId: string = BASE.zone_id) => ({
    device: { id: DEVICE_UUID },
    zoneId,
  });

  beforeEach(async () => {
    mintForCtx = vi.fn().mockResolvedValue({
      brokkr_live_token: 'test-live-token-t',
      endpoint: 'https://hub/phone-home',
      exp: 1_900_000_000,
    });
    writeAtomForCtx = vi.fn().mockResolvedValue(undefined);
    mintDeployForCtx = vi
      .fn()
      .mockResolvedValue({ deployment_os_token: 'dep_os', endpoint: 'https://hub/phone-home' });
    writeDeployAtomForCtx = vi.fn().mockResolvedValue(undefined);
    resolveZoneContext = vi.fn().mockResolvedValue(makeCtx());
    deviceFindUnique = vi.fn().mockResolvedValue({ id: DEVICE_UUID });
    writeRecordForDevice = vi.fn().mockResolvedValue({ written: true });
    writePlaceholder = vi
      .fn()
      .mockResolvedValue({ id: 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee', result: { written: true } });
    resolverResolve = vi.fn().mockResolvedValue({ kind: 'pending' });
    renderLiveNetplan = vi.fn().mockResolvedValue('network:\n  version: 2\n');
    publishDeviceSecret = vi.fn().mockResolvedValue({ written: true });
    writeAtomJson = vi.fn().mockResolvedValue({ written: true });
    writeAtomError = vi.fn().mockResolvedValue({ written: true });
    loggerLog = vi.fn();
    loggerWarn = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RenderRequestDispatcher,
        {
          provide: ServerTokenService,
          useValue: { mintForCtx, writeAtomForCtx, mintDeployForCtx, writeDeployAtomForCtx },
        },
        {
          provide: DeviceContextService,
          useValue: { resolveZoneContext },
        },
        {
          provide: DeviceRecordPublisher,
          useValue: { writeForDevice: writeRecordForDevice, writePlaceholder },
        },
        {
          provide: DeviceResolverService,
          useValue: { resolve: resolverResolve },
        },
        {
          provide: NetplanPublisherService,
          useValue: { renderLiveNetplan },
        },
        {
          provide: DeviceSecretAtomPublisher,
          useValue: { publishCurrent: publishDeviceSecret },
        },
        {
          provide: ConfigAtomWriter,
          useValue: { writeAtomJson, writeAtomError },
        },
        {
          provide: PrismaClient,
          useValue: { device: { findUnique: deviceFindUnique } },
        },
        {
          provide: `LoggerService${RenderRequestDispatcher.name}`,
          useValue: {
            log: loggerLog,
            warn: loggerWarn,
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    dispatcher = module.get(RenderRequestDispatcher);
  });

  describe("domain='server_token'", () => {
    it('looks up the Device by UUID entity_id and writes the atom', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'server_token',
        params: { entity_id: DEVICE_UUID },
        reason: 'missing',
      };

      await dispatcher.dispatch(req);

      expect(deviceFindUnique).toHaveBeenCalledOnce();
      expect(deviceFindUnique).toHaveBeenCalledWith({
        where: { id: DEVICE_UUID },
        select: { id: true },
      });
      expect(resolveZoneContext).toHaveBeenCalledWith(DEVICE_UUID);
      expect(mintForCtx).toHaveBeenCalledOnce();
      expect(mintForCtx).toHaveBeenCalledWith(makeCtx());
      expect(writeAtomForCtx).toHaveBeenCalledOnce();
      expect(writeAtomForCtx).toHaveBeenCalledWith(
        makeCtx(),
        { brokkr_live_token: 'test-live-token-t', endpoint: 'https://hub/phone-home', exp: 1_900_000_000 },
        { requestId: BASE.request_id },
      );
      expect(writeAtomError).not.toHaveBeenCalled();
    });

    it('writes negative-cache envelope under the polling zone and skips the mint when the device resolves to a different zone', async () => {
      resolveZoneContext.mockResolvedValueOnce(makeCtx('99999999-9999-9999-9999-999999999999'));

      const req: RenderRequest = {
        ...BASE,
        domain: 'server_token',
        params: { entity_id: DEVICE_UUID },
        reason: 'missing',
      };

      await dispatcher.dispatch(req);

      expect(mintForCtx).not.toHaveBeenCalled();
      expect(writeAtomForCtx).not.toHaveBeenCalled();
      expect(writeAtomError).toHaveBeenCalledOnce();
      expect(writeAtomError).toHaveBeenCalledWith(
        BASE.zone_id,
        serverToken(DEVICE_UUID),
        expect.stringContaining('resolves to zone'),
        TTL_NEGATIVE_CACHE_SECONDS,
        { request_id: BASE.request_id },
      );
    });

    it('throws BadRequestException when params.entity_id is missing', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'server_token',
        params: {},
      };

      await expect(dispatcher.dispatch(req)).rejects.toBeInstanceOf(BadRequestException);
      expect(deviceFindUnique).not.toHaveBeenCalled();
      expect(mintForCtx).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when params.entity_id is not a string', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'server_token',
        params: { entity_id: 42 },
      };

      await expect(dispatcher.dispatch(req)).rejects.toBeInstanceOf(BadRequestException);
      expect(deviceFindUnique).not.toHaveBeenCalled();
      expect(mintForCtx).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when params.entity_id is empty string', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'server_token',
        params: { entity_id: '' },
      };

      await expect(dispatcher.dispatch(req)).rejects.toBeInstanceOf(BadRequestException);
      expect(deviceFindUnique).not.toHaveBeenCalled();
      expect(mintForCtx).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when params is omitted entirely', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'server_token',
      };

      await expect(dispatcher.dispatch(req)).rejects.toBeInstanceOf(BadRequestException);
      expect(deviceFindUnique).not.toHaveBeenCalled();
      expect(mintForCtx).not.toHaveBeenCalled();
    });

    it('writes negative-cache envelope and throws BadRequestException when no Device matches the UUID', async () => {
      deviceFindUnique.mockResolvedValueOnce(null);

      const req: RenderRequest = {
        ...BASE,
        domain: 'server_token',
        params: { entity_id: DEVICE_UUID },
      };

      await expect(dispatcher.dispatch(req)).rejects.toThrow(/no Device with id=/);
      expect(mintForCtx).not.toHaveBeenCalled();
      expect(writeAtomError).toHaveBeenCalledOnce();
      expect(writeAtomError).toHaveBeenCalledWith(
        BASE.zone_id,
        serverToken(DEVICE_UUID),
        expect.stringContaining('no Device with id='),
        TTL_NEGATIVE_CACHE_SECONDS,
        { request_id: BASE.request_id },
      );
    });

    it('writes negative-cache envelope on ServerTokenService error instead of propagating', async () => {
      mintForCtx.mockRejectedValueOnce(new Error('token mint unreachable'));

      const req: RenderRequest = {
        ...BASE,
        domain: 'server_token',
        params: { entity_id: DEVICE_UUID },
      };

      await dispatcher.dispatch(req);

      expect(writeAtomError).toHaveBeenCalledOnce();
      expect(writeAtomError).toHaveBeenCalledWith(
        BASE.zone_id,
        serverToken(DEVICE_UUID),
        expect.stringContaining('token mint unreachable'),
        TTL_NEGATIVE_CACHE_SECONDS,
        { request_id: BASE.request_id },
      );
    });
  });

  describe("domain='deploy_token'", () => {
    it('looks up the Device by UUID entity_id and mints+writes the deploy_token atom', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'deploy_token',
        params: { entity_id: DEVICE_UUID },
        reason: 'missing',
      };

      await dispatcher.dispatch(req);

      expect(deviceFindUnique).toHaveBeenCalledOnce();
      expect(deviceFindUnique).toHaveBeenCalledWith({
        where: { id: DEVICE_UUID },
        select: { id: true },
      });
      expect(resolveZoneContext).toHaveBeenCalledWith(DEVICE_UUID);
      expect(mintDeployForCtx).toHaveBeenCalledOnce();
      expect(mintDeployForCtx).toHaveBeenCalledWith(makeCtx());
      expect(writeDeployAtomForCtx).toHaveBeenCalledOnce();
      expect(writeDeployAtomForCtx).toHaveBeenCalledWith(
        makeCtx(),
        { deployment_os_token: 'dep_os', endpoint: 'https://hub/phone-home' },
        { requestId: BASE.request_id },
      );
      expect(mintForCtx).not.toHaveBeenCalled();
      expect(writeAtomForCtx).not.toHaveBeenCalled();
      expect(writeAtomError).not.toHaveBeenCalled();
    });

    it('rejects a missing entity_id', async () => {
      const req: RenderRequest = { ...BASE, domain: 'deploy_token', params: {} };
      await expect(dispatcher.dispatch(req)).rejects.toBeInstanceOf(BadRequestException);
      expect(mintDeployForCtx).not.toHaveBeenCalled();
    });

    it('writes the deploy_token negative-cache envelope when the device does not exist', async () => {
      deviceFindUnique.mockResolvedValueOnce(null);

      const req: RenderRequest = { ...BASE, domain: 'deploy_token', params: { entity_id: DEVICE_UUID } };
      await expect(dispatcher.dispatch(req)).rejects.toBeInstanceOf(BadRequestException);

      expect(writeAtomError).toHaveBeenCalledOnce();
      expect(writeAtomError).toHaveBeenCalledWith(
        BASE.zone_id,
        deployToken(DEVICE_UUID),
        expect.stringContaining(`no Device with id=${DEVICE_UUID}`),
        TTL_NEGATIVE_CACHE_SECONDS,
        { request_id: BASE.request_id },
      );
      expect(mintDeployForCtx).not.toHaveBeenCalled();
    });

    it('writes the deploy_token negative-cache envelope under the polling zone on a zone mismatch', async () => {
      resolveZoneContext.mockResolvedValueOnce(makeCtx('99999999-9999-9999-9999-999999999999'));

      const req: RenderRequest = { ...BASE, domain: 'deploy_token', params: { entity_id: DEVICE_UUID } };
      await dispatcher.dispatch(req);

      expect(mintDeployForCtx).not.toHaveBeenCalled();
      expect(writeAtomError).toHaveBeenCalledOnce();
      expect(writeAtomError).toHaveBeenCalledWith(
        BASE.zone_id,
        deployToken(DEVICE_UUID),
        expect.stringContaining('bridge polls zone'),
        TTL_NEGATIVE_CACHE_SECONDS,
        { request_id: BASE.request_id },
      );
      expect(writeDeployAtomForCtx).not.toHaveBeenCalled();
    });

    it('writes a negative-cache envelope on mint error instead of propagating', async () => {
      mintDeployForCtx.mockRejectedValueOnce(new Error('token mint unreachable'));

      const req: RenderRequest = { ...BASE, domain: 'deploy_token', params: { entity_id: DEVICE_UUID } };
      await dispatcher.dispatch(req);

      expect(writeAtomError).toHaveBeenCalledOnce();
      expect(writeAtomError).toHaveBeenCalledWith(
        BASE.zone_id,
        deployToken(DEVICE_UUID),
        expect.stringContaining('token mint unreachable'),
        TTL_NEGATIVE_CACHE_SECONDS,
        { request_id: BASE.request_id },
      );
    });
  });

  describe("domain='device_record'", () => {
    it('publishes a real-device record when entity_id (UUID) maps to a Device by id', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'device_record',
        params: { entity_id: DEVICE_UUID },
        reason: 'missing',
      };

      await dispatcher.dispatch(req);

      expect(deviceFindUnique).toHaveBeenCalledWith({
        where: { id: DEVICE_UUID, deletedAt: null },
        select: { id: true },
      });
      expect(writeRecordForDevice).toHaveBeenCalledWith(DEVICE_UUID, { requestId: BASE.request_id });
      expect(resolverResolve).not.toHaveBeenCalled();
      expect(writePlaceholder).not.toHaveBeenCalled();
    });

    it('logs a skip (not a success) when the entity_id publish is skipped (written=false)', async () => {
      writeRecordForDevice.mockResolvedValueOnce({ written: false, reason: 'role-not-published' });

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_record',
        params: { entity_id: DEVICE_UUID },
      };

      await dispatcher.dispatch(req);

      expect(writeRecordForDevice).toHaveBeenCalledWith(DEVICE_UUID, { requestId: BASE.request_id });
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringMatching(/Skipped device_record publish.*role-not-published/),
        BASE.request_id,
      );
      expect(loggerLog).not.toHaveBeenCalledWith(expect.stringMatching(/Rendered device_record atom/));
    });

    it('throws BadRequestException when entity_id has no real Device (placeholder UUID — cannot re-render without identifiers)', async () => {
      deviceFindUnique.mockResolvedValueOnce(null);

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_record',
        params: { entity_id: 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee' },
      };

      await expect(dispatcher.dispatch(req)).rejects.toThrow(/cannot re-render id .* without identifiers/);
      expect(writeRecordForDevice).not.toHaveBeenCalled();
      expect(writePlaceholder).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when entity_id is an empty string', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'device_record',
        params: { entity_id: '' },
      };

      await expect(dispatcher.dispatch(req)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolves identifiers to a real device and publishes the real-device record', async () => {
      resolverResolve.mockResolvedValueOnce({
        kind: 'known',
        device: { id: DEVICE_UUID },
        matchedOn: 'mac',
      });

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_record',
        params: { identifiers: { mac: 'aa:bb:cc:dd:ee:ff' } },
      };

      await dispatcher.dispatch(req);

      expect(resolverResolve).toHaveBeenCalledWith({ mac: 'aa:bb:cc:dd:ee:ff' });
      expect(writeRecordForDevice).toHaveBeenCalledWith(DEVICE_UUID, { requestId: BASE.request_id });
      expect(writePlaceholder).not.toHaveBeenCalled();
    });

    it('logs a skip (not a success) when the resolved-device publish is skipped (written=false)', async () => {
      resolverResolve.mockResolvedValueOnce({
        kind: 'known',
        device: { id: DEVICE_UUID },
        matchedOn: 'mac',
      });
      writeRecordForDevice.mockResolvedValueOnce({ written: false, reason: 'stale' });

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_record',
        params: { identifiers: { mac: 'aa:bb:cc:dd:ee:ff' } },
      };

      await dispatcher.dispatch(req);

      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringMatching(/Skipped device_record publish.*matched on mac.*stale/),
        BASE.request_id,
      );
      expect(loggerLog).not.toHaveBeenCalledWith(expect.stringMatching(/Rendered device_record atom/));
      expect(writePlaceholder).not.toHaveBeenCalled();
    });

    it('mints a placeholder when the identifier resolver returns pending', async () => {
      resolverResolve.mockResolvedValueOnce({ kind: 'pending' });

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_record',
        params: { identifiers: { mac: 'aa:bb:cc:dd:ee:ff' }, buildarch: 'amd64-x86_64' },
      };

      await dispatcher.dispatch(req);

      expect(writePlaceholder).toHaveBeenCalledWith(
        { mac: 'aa:bb:cc:dd:ee:ff' },
        { buildarch: 'amd64-x86_64', zoneId: BASE.zone_id, requestId: BASE.request_id },
      );
      expect(writeRecordForDevice).not.toHaveBeenCalled();
    });

    it('passes buildarch=null when the param is missing or empty', async () => {
      resolverResolve.mockResolvedValueOnce({ kind: 'pending' });

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_record',
        params: { identifiers: { mac: 'aa:bb:cc:dd:ee:ff' } },
      };

      await dispatcher.dispatch(req);

      expect(writePlaceholder).toHaveBeenCalledWith(
        { mac: 'aa:bb:cc:dd:ee:ff' },
        { buildarch: null, zoneId: BASE.zone_id, requestId: BASE.request_id },
      );
    });

    it('warns and returns early when the placeholder mint is skipped (stale)', async () => {
      resolverResolve.mockResolvedValueOnce({ kind: 'pending' });
      writePlaceholder.mockResolvedValueOnce({
        id: 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
        result: { written: false, reason: 'stale' },
      });

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_record',
        params: { identifiers: { mac: 'aa:bb:cc:dd:ee:ff' } },
      };

      await dispatcher.dispatch(req);

      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringMatching(/Skipped placeholder device_record mint/i),
        BASE.request_id,
      );
      expect(loggerLog).not.toHaveBeenCalledWith(expect.stringMatching(/Minted placeholder device_record/i));
    });

    it('throws BadRequestException when neither entity_id nor identifiers are present', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'device_record',
        params: {},
      };

      await expect(dispatcher.dispatch(req)).rejects.toBeInstanceOf(BadRequestException);
      expect(writeRecordForDevice).not.toHaveBeenCalled();
      expect(writePlaceholder).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when identifiers fail Zod validation', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'device_record',
        params: { identifiers: { mac: 42 } },
      };

      await expect(dispatcher.dispatch(req)).rejects.toBeInstanceOf(BadRequestException);
      expect(resolverResolve).not.toHaveBeenCalled();
    });
  });

  describe("domain='netplan'", () => {
    const NETPLAN_YAML = 'network:\n  version: 2\n  ethernets:\n    enp1s0: {}\n';

    it('renders the live netplan and writes an envelope with the 20-minute TTL + correct key', async () => {
      renderLiveNetplan.mockResolvedValueOnce(NETPLAN_YAML);

      const req: RenderRequest = {
        ...BASE,
        domain: 'netplan',
        params: { entity_id: DEVICE_UUID },
        reason: 'missing',
      };

      await dispatcher.dispatch(req);

      expect(renderLiveNetplan).toHaveBeenCalledWith({
        deviceId: DEVICE_UUID,
        jobId: BASE.request_id,
      });

      expect(writeAtomJson).toHaveBeenCalledTimes(1);
      const [zoneArg, keyArg, valueArg, schemaArg, ttlArg, optsArg] = writeAtomJson.mock.calls[0];
      expect(zoneArg).toBe(BASE.zone_id);
      expect(keyArg).toBe(netplanConfig(DEVICE_UUID, 'live'));
      expect(valueArg).toEqual({ yaml: NETPLAN_YAML });
      expect(schemaArg).toBe(NetplanAtomSchema);
      expect(ttlArg).toBe(NETPLAN_LIVE_TTL_SECONDS);
      expect(ttlArg).toBe(20 * 60);
      expect(optsArg).toEqual({ request_id: BASE.request_id });

      expect(writeAtomError).not.toHaveBeenCalled();
    });

    it('writes a negative-cache envelope when the renderer throws (e.g. device has no platform set)', async () => {
      renderLiveNetplan.mockRejectedValueOnce(new Error('Device has no current platform set'));

      const req: RenderRequest = {
        ...BASE,
        domain: 'netplan',
        params: { entity_id: DEVICE_UUID },
      };

      await dispatcher.dispatch(req);

      expect(writeAtomJson).not.toHaveBeenCalled();
      expect(writeAtomError).toHaveBeenCalledTimes(1);
      const [, , reasonArg, ttlArg] = writeAtomError.mock.calls[0];
      expect(reasonArg).toMatch(/no current platform/);
      expect(ttlArg).toBe(TTL_NEGATIVE_CACHE_SECONDS);
    });

    it('throws BadRequestException when params.entity_id is missing or empty', async () => {
      const reqMissing: RenderRequest = {
        ...BASE,
        domain: 'netplan',
        params: {},
      };
      await expect(dispatcher.dispatch(reqMissing)).rejects.toBeInstanceOf(BadRequestException);

      const reqEmpty: RenderRequest = {
        ...BASE,
        domain: 'netplan',
        params: { entity_id: '' },
      };
      await expect(dispatcher.dispatch(reqEmpty)).rejects.toBeInstanceOf(BadRequestException);

      expect(renderLiveNetplan).not.toHaveBeenCalled();
      expect(writeAtomJson).not.toHaveBeenCalled();
    });

    it('writes a negative-cache envelope (writeAtomError) with the short TTL when the renderer throws', async () => {
      renderLiveNetplan.mockRejectedValueOnce(new Error('renderer unreachable'));

      const req: RenderRequest = {
        ...BASE,
        domain: 'netplan',
        params: { entity_id: DEVICE_UUID },
      };

      await dispatcher.dispatch(req);

      expect(writeAtomJson).not.toHaveBeenCalled();
      expect(writeAtomError).toHaveBeenCalledTimes(1);
      const [zoneArg, keyArg, reasonArg, ttlArg, optsArg] = writeAtomError.mock.calls[0];
      expect(zoneArg).toBe(BASE.zone_id);
      expect(keyArg).toBe(netplanConfig(DEVICE_UUID, 'live'));
      expect(reasonArg).toBe('renderer unreachable');
      expect(ttlArg).toBe(TTL_NEGATIVE_CACHE_SECONDS);
      expect(optsArg).toEqual({ request_id: BASE.request_id });
    });

    it('writes a negative-cache envelope with reason=empty_render when the renderer returns whitespace-only YAML', async () => {
      renderLiveNetplan.mockResolvedValueOnce('   \n\n');

      const req: RenderRequest = {
        ...BASE,
        domain: 'netplan',
        params: { entity_id: DEVICE_UUID },
      };

      await dispatcher.dispatch(req);

      expect(writeAtomJson).not.toHaveBeenCalled();
      expect(writeAtomError).toHaveBeenCalledTimes(1);
      const [, , reasonArg, ttlArg] = writeAtomError.mock.calls[0];
      expect(reasonArg).toBe('empty_render');
      expect(ttlArg).toBe(TTL_NEGATIVE_CACHE_SECONDS);
    });

    it('skips the success log and does not double-write when writeAtomJson reports STALE', async () => {
      renderLiveNetplan.mockResolvedValueOnce(NETPLAN_YAML);
      writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });

      const req: RenderRequest = {
        ...BASE,
        domain: 'netplan',
        params: { entity_id: DEVICE_UUID },
      };

      await dispatcher.dispatch(req);

      expect(writeAtomJson).toHaveBeenCalledTimes(1);
      expect(writeAtomError).not.toHaveBeenCalled();
    });
  });

  describe("domain='device_secret'", () => {
    it('publishes the current sealed secret (default BMC/USER) with the BRIDGE actor and request id', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'device_secret',
        params: { entity_id: DEVICE_UUID },
        reason: 'missing',
      };

      await dispatcher.dispatch(req);

      expect(resolveZoneContext).toHaveBeenCalledWith(DEVICE_UUID);
      expect(publishDeviceSecret).toHaveBeenCalledWith(
        DEVICE_UUID,
        DeviceSecretPurpose.BMC,
        DeviceSecretKind.USER,
        { type: DeviceSecretActorType.BRIDGE, id: BASE.bridge_id },
        { requestId: BASE.request_id },
      );
      expect(writeAtomError).not.toHaveBeenCalled();
    });

    it('honours explicit params.purpose / params.kind', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'device_secret',
        params: { entity_id: DEVICE_UUID, purpose: DeviceSecretPurpose.CONSOLE, kind: DeviceSecretKind.TOKEN },
      };

      await dispatcher.dispatch(req);

      expect(publishDeviceSecret).toHaveBeenCalledWith(
        DEVICE_UUID,
        DeviceSecretPurpose.CONSOLE,
        DeviceSecretKind.TOKEN,
        { type: DeviceSecretActorType.BRIDGE, id: BASE.bridge_id },
        { requestId: BASE.request_id },
      );
    });

    it('throws BadRequestException on an unknown purpose, before any publish', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'device_secret',
        params: { entity_id: DEVICE_UUID, purpose: 'NOT_A_PURPOSE' },
      };

      await expect(dispatcher.dispatch(req)).rejects.toBeInstanceOf(BadRequestException);
      expect(publishDeviceSecret).not.toHaveBeenCalled();
      expect(deviceFindUnique).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when params.entity_id is missing', async () => {
      const req: RenderRequest = {
        ...BASE,
        domain: 'device_secret',
        params: {},
      };

      await expect(dispatcher.dispatch(req)).rejects.toBeInstanceOf(BadRequestException);
      expect(publishDeviceSecret).not.toHaveBeenCalled();
    });

    it('writes a negative-cache envelope and throws when no Device matches the UUID', async () => {
      deviceFindUnique.mockResolvedValueOnce(null);

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_secret',
        params: { entity_id: DEVICE_UUID },
      };

      await expect(dispatcher.dispatch(req)).rejects.toThrow(/no Device with id=/);
      expect(publishDeviceSecret).not.toHaveBeenCalled();
      expect(writeAtomError).toHaveBeenCalledWith(
        BASE.zone_id,
        deviceSecret(DEVICE_UUID, DeviceSecretPurpose.BMC, DeviceSecretKind.USER),
        expect.stringContaining('no Device with id='),
        TTL_NEGATIVE_CACHE_SECONDS,
        { request_id: BASE.request_id },
      );
    });

    it('writes a negative-cache envelope under the polling zone on a zone mismatch (no publish)', async () => {
      resolveZoneContext.mockResolvedValueOnce(makeCtx('99999999-9999-9999-9999-999999999999'));

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_secret',
        params: { entity_id: DEVICE_UUID },
      };

      await dispatcher.dispatch(req);

      expect(publishDeviceSecret).not.toHaveBeenCalled();
      expect(writeAtomError).toHaveBeenCalledWith(
        BASE.zone_id,
        deviceSecret(DEVICE_UUID, DeviceSecretPurpose.BMC, DeviceSecretKind.USER),
        expect.stringContaining('resolves to zone'),
        TTL_NEGATIVE_CACHE_SECONDS,
        { request_id: BASE.request_id },
      );
    });

    it('writes a negative-cache envelope when the publisher reports no-secret (terminates the poll)', async () => {
      publishDeviceSecret.mockResolvedValueOnce({ written: false, reason: 'no-secret' });

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_secret',
        params: { entity_id: DEVICE_UUID },
      };

      await dispatcher.dispatch(req);

      expect(writeAtomError).toHaveBeenCalledWith(
        BASE.zone_id,
        deviceSecret(DEVICE_UUID, DeviceSecretPurpose.BMC, DeviceSecretKind.USER),
        'no-secret',
        TTL_NEGATIVE_CACHE_SECONDS,
        { request_id: BASE.request_id },
      );
    });

    it('does NOT write a negative-cache envelope on a benign stale write (a newer atom already won)', async () => {
      publishDeviceSecret.mockResolvedValueOnce({ written: false, reason: 'stale' });

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_secret',
        params: { entity_id: DEVICE_UUID },
      };

      await dispatcher.dispatch(req);

      expect(writeAtomError).not.toHaveBeenCalled();
    });

    it('writes a negative-cache envelope (no throw) when the publisher throws', async () => {
      publishDeviceSecret.mockRejectedValueOnce(new Error('seal store unavailable'));

      const req: RenderRequest = {
        ...BASE,
        domain: 'device_secret',
        params: { entity_id: DEVICE_UUID },
      };

      await dispatcher.dispatch(req);

      expect(writeAtomError).toHaveBeenCalledWith(
        BASE.zone_id,
        deviceSecret(DEVICE_UUID, DeviceSecretPurpose.BMC, DeviceSecretKind.USER),
        expect.stringContaining('seal store unavailable'),
        TTL_NEGATIVE_CACHE_SECONDS,
        { request_id: BASE.request_id },
      );
    });
  });
});
