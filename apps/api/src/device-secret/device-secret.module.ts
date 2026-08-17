import { Module, forwardRef } from '@nestjs/common';
import { InstanceOperatorGuard } from 'src/auth/guards/instance-operator.guard';
import { BrokkrBridgeModule } from 'src/brokkr-bridge/brokkr-bridge.module';
import { RedisModule } from 'src/common/redis';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ZoneCryptoModule } from 'src/zone-crypto/zone-crypto.module';

import { DeviceSecretAccessService } from './device-secret-access.service';
import { DeviceSecretAtomPublisher } from './device-secret-atom-publisher.service';
import { DeviceSecretCoreModule } from './device-secret-core.module';
import { DeviceSecretController } from './device-secret.controller';

@Module({
  imports: [DeviceSecretCoreModule, PrismaModule, ZoneCryptoModule, RedisModule, forwardRef(() => BrokkrBridgeModule)],
  controllers: [DeviceSecretController],
  providers: [DeviceSecretAccessService, DeviceSecretAtomPublisher, InstanceOperatorGuard],
  exports: [DeviceSecretCoreModule, DeviceSecretAtomPublisher],
})
export class DeviceSecretModule {}
