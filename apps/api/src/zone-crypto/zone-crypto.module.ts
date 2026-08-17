import { Module } from '@nestjs/common';
import { InstanceOperatorGuard } from 'src/auth/guards/instance-operator.guard';
import { PrismaModule } from 'src/prisma/prisma.module';

import { ZoneRegistrationTokenGuard } from './guards/zone-registration-token.guard';
import { ZoneCryptoConfig } from './zone-crypto.config';
import { ZoneCryptoController } from './zone-crypto.controller';
import { ZoneCryptoRepository } from './zone-crypto.repository';
import { ZoneCryptoService } from './zone-crypto.service';
import { ZoneRegistrationTokenController } from './zone-registration-token.controller';
import { ZoneRegistrationTokenService } from './zone-registration-token.service';

@Module({
  imports: [PrismaModule],
  controllers: [ZoneCryptoController, ZoneRegistrationTokenController],
  providers: [
    ZoneCryptoConfig,
    ZoneCryptoRepository,
    ZoneCryptoService,
    ZoneRegistrationTokenGuard,
    ZoneRegistrationTokenService,
    InstanceOperatorGuard,
  ],
  exports: [ZoneCryptoConfig, ZoneCryptoRepository],
})
export class ZoneCryptoModule {}
