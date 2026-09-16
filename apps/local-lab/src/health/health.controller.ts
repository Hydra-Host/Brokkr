import { Controller, Get } from '@nestjs/common';

import { PublicLabRoute } from '../common/lab-route';

/** Its own controller so the exemption cannot be inherited by proximity: nothing else may live here,
 *  and the body stays a constant so no state can leak through the one unauthenticated route. */
@Controller('api')
export class HealthController {
  @Get('health')
  @PublicLabRoute()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
