import { Module } from '@nestjs/common';
import { DeviceTokensModule } from 'src/device-tokens/device-tokens.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { RedisModule } from '../../common/redis';
import { DeviceContextModule } from '../device-context/device-context.module';
import { ServerTokenService } from './server-token.service';

@Module({
  imports: [DeviceContextModule, DeviceTokensModule, PrismaModule, RedisModule],
  providers: [ServerTokenService],
  exports: [ServerTokenService],
})
export class ServerTokenModule {}
