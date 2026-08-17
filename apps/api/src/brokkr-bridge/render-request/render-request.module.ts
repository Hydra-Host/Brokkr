import { Module, forwardRef } from '@nestjs/common';
import { RedisModule } from 'src/common/redis';
import { DeviceSecretModule } from 'src/device-secret/device-secret.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { DeviceContextModule } from '../device-context/device-context.module';
import { DeviceRecordModule } from '../device-record/device-record.module';
import { NetplanModule } from '../netplan/netplan.module';
import { ServerTokenModule } from '../server-token/server-token.module';
import { RenderRequestDispatcher } from './render-request-dispatcher.service';

@Module({
  imports: [
    DeviceRecordModule,
    DeviceContextModule,
    NetplanModule,
    PrismaModule,
    RedisModule,
    ServerTokenModule,
    forwardRef(() => DeviceSecretModule),
  ],
  providers: [RenderRequestDispatcher],
  exports: [RenderRequestDispatcher],
})
export class RenderRequestModule {}
