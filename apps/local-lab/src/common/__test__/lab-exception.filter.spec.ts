import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpException,
  Logger,
  Module,
  NotFoundException,
  Res,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import type { Response } from 'express';
import { afterAll, beforeAll, vi } from 'vitest';

import { contract } from '../../contract';
import { LabExceptionFilter } from '../lab-exception.filter';

@Controller()
class ThrowingController {
  @Get('plain/not-found')
  notFound(): never {
    throw new NotFoundException("run 'nope' not found");
  }

  @Get('plain/conflict')
  conflict(): never {
    throw new ConflictException('already running');
  }

  @Get('plain/bad-request')
  badRequest(): never {
    throw new BadRequestException('invalid sha256');
  }

  @Get('plain/teapot')
  teapot(): never {
    throw new HttpException('short and stout', 418);
  }

  @Get('plain/error')
  plainError(): never {
    throw new Error('boom');
  }

  @Get('plain/after-headers')
  afterHeaders(@Res() res: Response): never {
    res.status(200).send('partial');
    throw new Error('exception after headers');
  }

  @TsRestHandler(contract.getMachineConsoleLog)
  consoleLog() {
    return tsRestHandler(contract.getMachineConsoleLog, async () => {
      throw new NotFoundException("unknown node 'nope'");
    });
  }
}

@Module({
  controllers: [ThrowingController],
  providers: [{ provide: APP_FILTER, useClass: LabExceptionFilter }],
})
class SpecModule {}

describe('LabExceptionFilter', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create(SpecModule, { logger: false });
    await app.listen(0);
    const addr: unknown = app.getHttpServer().address();
    if (typeof addr !== 'object' || addr === null || !('port' in addr)) throw new Error('expected an AddressInfo');
    base = `http://127.0.0.1:${String(addr.port)}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['plain/not-found', 404, "run 'nope' not found"],
    ['plain/conflict', 409, 'already running'],
    ['plain/bad-request', 400, 'invalid sha256'],
    ['plain/teapot', 418, 'short and stout'],
    ['plain/error', 500, 'boom'],
  ])('maps %s to %i with an { error } body', async (path, status, message) => {
    const res = await fetch(`${base}/${path}`);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: message });
  });

  it('fires for exceptions thrown inside a tsRestHandler callback', async () => {
    const res = await fetch(`${base}/api/fleet/machines/nope/console-log`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown node 'nope'" });
  });

  it('logs instead of writing a body when headers are already sent', async () => {
    const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const res = await fetch(`${base}/plain/after-headers`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('partial');
    expect(errSpy).toHaveBeenCalledWith('exception after headers', expect.any(String));
    errSpy.mockRestore();
  });

  it('passes ts-rest request-validation payloads through untouched', async () => {
    const res = await fetch(`${base}/api/fleet/machines/nope/console-log?tail_bytes=abc`);
    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    expect(body).toHaveProperty('queryResult');
    expect(body).not.toHaveProperty('error');
  });
});
