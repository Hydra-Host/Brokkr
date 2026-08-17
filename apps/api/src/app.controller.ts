import { Controller, Get, Req, Res, Version, VERSION_NEUTRAL } from '@nestjs/common';
import { Request, Response } from 'express';
import { API_VERSION } from 'src/constants';
import { Public } from './auth/decorators/public.decorator';

@Controller()
export class AppController {
  constructor() {}

  @Get('/healthcheck')
  @Public()
  getHealthcheck(@Res() res: Response) {
    return res.status(200).send('OK');
  }

  @Get('/version')
  @Public()
  @Version(VERSION_NEUTRAL)
  getVersion(@Res() res: Response) {
    return res.status(200).send(`v${API_VERSION}`);
  }

  @Get('/whoami')
  @Public()
  whoami(@Req() req: Request, @Res() res: Response) {
    const ip = (req.ip ?? '').replace(/^::ffff:/, '') || 'unknown';
    return res.status(200).type('text/plain').send(`${ip}\n`);
  }
}
