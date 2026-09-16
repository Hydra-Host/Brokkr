import { Test } from '@nestjs/testing';
import { request as expressRequest } from 'express';

import { OverlayStoreService } from '../overlay-store';
import { ProcessComposeClient } from '../process-compose.client';
import { ProcessEnvService } from '../process-env.service';
import { RedeployService } from '../redeploy.service';
import { RepoBranchService } from '../repo-branch.service';
import { RosterService } from '../roster.service';
import { ServicesController } from '../services.controller';

import type { Request } from 'express';

const REMOTE = '10.0.0.5';

function requestFrom(peer: string, forwardedFor?: string, token?: string): Request {
  const forwarded = forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor };
  return Object.assign(Object.create(expressRequest, { ip: { value: peer }, query: { value: {} } }), {
    socket: { remoteAddress: peer },
    headers: token === undefined ? forwarded : { ...forwarded, authorization: `Bearer ${token}` },
  });
}

describe('ServicesController.getProcessEnv reveal gate', () => {
  const getProcessEnv = vi.fn(async (name: string, reveal: boolean) => ({
    name,
    source: 'configured',
    vars: [],
    reveal,
  }));
  let controller: ServicesController;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ServicesController],
      providers: [
        { provide: ProcessEnvService, useValue: { getProcessEnv } },
        { provide: RedeployService, useValue: {} },
        { provide: RosterService, useValue: {} },
        { provide: ProcessComposeClient, useValue: {} },
        { provide: OverlayStoreService, useValue: {} },
        { provide: RepoBranchService, useValue: {} },
      ],
    }).compile();
    controller = moduleRef.get(ServicesController);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    getProcessEnv.mockClear();
  });

  async function revealedFor(peer: string, forwardedFor?: string, reveal?: boolean, token?: string): Promise<boolean> {
    const handler = controller.getProcessEnv(requestFrom(peer, forwardedFor, token));
    const res = await handler({ params: { name: 'hub' }, query: { reveal }, headers: {} });
    expect(res.status).toBe(200);
    expect(getProcessEnv).toHaveBeenCalledTimes(1);
    return getProcessEnv.mock.calls[0][1];
  }

  it('reveals for a loopback peer with no forwarded hop', async () => {
    expect(await revealedFor('127.0.0.1', undefined, true)).toBe(true);
  });

  it('masks for a loopback peer whose forwarded hop is not loopback', async () => {
    expect(await revealedFor('127.0.0.1', REMOTE, true)).toBe(false);
  });

  it('masks for a loopback peer in fronted mode', async () => {
    vi.stubEnv('LAB_MODE', 'fronted');
    expect(await revealedFor('127.0.0.1', undefined, true)).toBe(false);
  });

  it('masks for a directly-connected non-loopback peer', async () => {
    expect(await revealedFor(REMOTE, undefined, true)).toBe(false);
  });

  it('masks for a remote peer holding only the api token', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-token');
    expect(await revealedFor(REMOTE, undefined, true, 'api-token')).toBe(false);
  });

  it('reveals for a remote peer holding the host token', async () => {
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');
    expect(await revealedFor(REMOTE, undefined, true, 'host-token')).toBe(true);
  });

  it('masks whatever the origin when reveal is not requested', async () => {
    expect(await revealedFor('127.0.0.1', undefined, false)).toBe(false);
    getProcessEnv.mockClear();
    expect(await revealedFor('127.0.0.1')).toBe(false);
  });
});
