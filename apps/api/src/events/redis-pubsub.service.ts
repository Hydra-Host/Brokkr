import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Subject } from 'rxjs';
import { Logger } from 'src/common/decorators/logger.decorator';
import { createRedisConnectionConfig } from 'src/common/redis/redis.config';
import { LoggerService } from 'src/logger/logger.service';
import { DeviceMetadataUpdatedEvent, DeviceMetadataUpdatedEventSchema } from './events.types';

const SSE_CHANNEL = 'sse:device-metadata-updated';

@Injectable()
export class RedisPubSubService implements OnModuleInit, OnModuleDestroy {
  private publisher: Redis;
  private subscriber: Redis;

  readonly deviceEvents$ = new Subject<DeviceMetadataUpdatedEvent>();

  constructor(
    private readonly configService: ConfigService,
    @Logger(RedisPubSubService.name) private readonly logger: LoggerService,
  ) {
    const config = createRedisConnectionConfig({
      redisUrl: this.configService.getOrThrow('REDIS_URL'),
      redisCaCert: this.configService.get('REDIS_CA_CERT'),
      nodeTlsRejectUnauthorized: this.configService.get('NODE_TLS_REJECT_UNAUTHORIZED'),
    });

    if (!config) {
      throw new Error('REDIS_URL must be defined for RedisPubSubService');
    }

    const redisOptions = config.tls ? { tls: config.tls } : {};
    this.publisher = new Redis(config.url, redisOptions);
    this.subscriber = new Redis(config.url, redisOptions);
  }

  async onModuleInit() {
    await this.subscriber.subscribe(SSE_CHANNEL);
    this.subscriber.on('message', (channel, message) => {
      if (channel !== SSE_CHANNEL) return;
      try {
        const event = DeviceMetadataUpdatedEventSchema.parse(JSON.parse(message));
        this.logger.log(`[SSE] Received from Redis: device=${event.deviceId}, deployment=${event.deploymentId}`);
        this.deviceEvents$.next(event);
      } catch {
        this.logger.warn('[SSE] Failed to parse Redis pub/sub message');
      }
    });
    this.logger.log('[SSE] Redis pub/sub subscribed to channel: ' + SSE_CHANNEL);
  }

  async onModuleDestroy() {
    await this.subscriber.unsubscribe(SSE_CHANNEL);
    this.subscriber.disconnect();
    this.publisher.disconnect();
  }

  async publish(event: DeviceMetadataUpdatedEvent) {
    this.logger.log(`[SSE] Publishing to Redis: device=${event.deviceId}, deployment=${event.deploymentId}`);
    await this.publisher.publish(SSE_CHANNEL, JSON.stringify(event));
  }
}
