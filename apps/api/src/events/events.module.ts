import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventsController } from './events.controller';
import { RedisPubSubService } from './redis-pubsub.service';

@Global()
@Module({
  imports: [ConfigModule],
  controllers: [EventsController],
  providers: [RedisPubSubService],
  exports: [RedisPubSubService],
})
export class EventsModule {}
