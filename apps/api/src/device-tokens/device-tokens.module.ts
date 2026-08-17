import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ContextModule } from 'src/common/context/context.module';
import { RedisModule } from 'src/common/redis';
import { PrismaModule } from 'src/prisma/prisma.module';
import { DeviceTokenAppService } from './device-token-app.service';
import { DeviceTokenGuard } from './device-token.guard';
import { DeviceTokensController } from './device-tokens.controller';
import { DeviceTokensService } from './device-tokens.service';

@Module({
  imports: [ConfigModule, ContextModule, PrismaModule, RedisModule],
  controllers: [DeviceTokensController],
  providers: [DeviceTokenAppService, DeviceTokensService, DeviceTokenGuard],
  exports: [DeviceTokensService, DeviceTokenGuard, DeviceTokenAppService],
})
export class DeviceTokensModule {}
