import { Global, Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ConfigAtomWriter } from './config-atom-writer.service';
import { type RedisTransportConnectionConfig, createRedisTransportConnectionConfig } from './redis.config';
import { REDIS_CLIENT, REDIS_CONFIG } from './redis.tokens';

export { REDIS_CLIENT, REDIS_CONFIG };

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CONFIG,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        return createRedisTransportConnectionConfig({
          redisUrl: configService.getOrThrow<string>('REDIS_URL'),
          redisCaCert: configService.get<string>('REDIS_CA_CERT'),
          nodeTlsRejectUnauthorized: configService.get<string>('NODE_TLS_REJECT_UNAUTHORIZED'),
        });
      },
    },
    {
      provide: REDIS_CLIENT,
      inject: [REDIS_CONFIG],
      useFactory: (config: RedisTransportConnectionConfig) => {
        const logger = new Logger('RedisModule');
        const client = new Redis({ ...config, lazyConnect: true });
        client.on('error', (err) => logger.error('Redis connection error', err));
        client.on('connect', () => logger.log('Redis connected'));
        client.connect().catch((err) => logger.error('Redis initial connection failed', err));
        return client;
      },
    },
    ConfigAtomWriter,
  ],
  exports: [REDIS_CLIENT, REDIS_CONFIG, ConfigAtomWriter],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy() {
    await this.redis.quit();
  }
}
