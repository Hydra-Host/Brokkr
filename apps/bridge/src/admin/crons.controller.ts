import { Controller, Get, Inject, Res } from '@nestjs/common';

import type { CronStateProvider } from './cron-state.js';
import { CRON_STATE_PROVIDER } from './cron-state.js';
import { renderCronStatesJson } from './wire-format.js';

// Node `setHeader` + Buffer body bypass Express paths that inject `; charset=utf-8` into the Content-Type — the response must be byte-identical, headers included.
interface ResponseLike {
  status(code: number): ResponseLike;
  setHeader(name: string, value: string): ResponseLike;
  send(body: Buffer): ResponseLike;
}

@Controller('admin')
export class CronsController {
  constructor(@Inject(CRON_STATE_PROVIDER) private readonly cronStateProvider: CronStateProvider) {}

  @Get('crons')
  listCrons(@Res() res: ResponseLike): void {
    const body = renderCronStatesJson(this.cronStateProvider.states());
    res.status(200).setHeader('Content-Type', 'application/json').send(Buffer.from(body, 'utf8'));
  }
}
