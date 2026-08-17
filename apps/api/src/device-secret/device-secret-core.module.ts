import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ZoneCryptoModule } from 'src/zone-crypto/zone-crypto.module';

import { DeviceSecretAuditService } from './device-secret-audit.service';
import { DeviceSecretService } from './device-secret.service';

@Module({
  imports: [PrismaModule, ZoneCryptoModule],
  providers: [DeviceSecretService, DeviceSecretAuditService],
  exports: [DeviceSecretService, DeviceSecretAuditService],
})
export class DeviceSecretCoreModule {}
