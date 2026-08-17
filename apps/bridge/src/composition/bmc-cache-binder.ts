import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { RedisService } from '../common/redis/redis.service.js';

import { setBmcCache } from './bmc-cache-holder.js';
import { setTelegrafCache } from './telegraf-cache-holder.js';

@Injectable()
export class BmcCacheBinder implements OnApplicationBootstrap {
  constructor(private readonly redis: RedisService) {}

  onApplicationBootstrap(): void {
    setBmcCache(this.redis);
    setTelegrafCache(this.redis);
  }
}
