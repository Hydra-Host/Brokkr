import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ResolveOutcome } from '../../device-record/device-record.service';
import { ChainService } from '../chain.service';
import { IpxeController } from '../ipxe.controller';

vi.mock('../../logger/logger.service', () => ({
  logInfo: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
  logWarning: vi.fn(async () => {}),
  logDebug: vi.fn(async () => {}),
}));

describe('iPXE /api/chain (wire — real urlencoded body through Fastify)', () => {
  let app: NestFastifyApplication;

  const chainStub = {
    validateRequest: vi.fn<(...args: unknown[]) => void>(),
    resolveRecord: vi.fn<(...args: unknown[]) => Promise<typeof ResolveOutcome.UNKNOWN>>(
      async () => ResolveOutcome.UNKNOWN,
    ),
    renderForRecord: vi.fn<(...args: unknown[]) => Promise<string>>(async () => '#!ipxe\necho Discovery Mode\nboot'),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IpxeController],
      providers: [{ provide: ChainService, useValue: chainStub }],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('parses the urlencoded form body and returns 200 + a rendered #!ipxe script', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chain',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'platform=efi&buildarch=x86_64&mac=00%3A11%3A22%3A33%3A44%3A55&serial=ABC-123',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.payload).toContain('#!ipxe');
    expect(res.payload).toContain('Discovery Mode');

    const identifiers = chainStub.resolveRecord.mock.calls[0]?.[0];
    expect(identifiers).toMatchObject({ mac: '00:11:22:33:44:55', serial: 'ABC-123' });
  });
});
