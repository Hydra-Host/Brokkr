import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { ContextService } from '../../common/context/context.service';
import { DeviceSecretService } from '../../device-secret/device-secret.service';
import { PrismaClient } from '../../prisma/prisma.client';
import { ZoneCryptoConfig } from '../../zone-crypto/zone-crypto.config';
import { ZoneCryptoRepository } from '../../zone-crypto/zone-crypto.repository';
import { ZoneRegistrationTokenService } from '../../zone-crypto/zone-registration-token.service';
import { SimSeedModule } from '../sim-seed.module';

describe('SimSeedModule', () => {
  it('resolves the services the sim scripts depend on', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SimSeedModule] })
      .overrideProvider(PrismaClient)
      .useValue({ onModuleInit: () => undefined, onModuleDestroy: () => undefined })
      .compile();

    expect(moduleRef.get(ZoneRegistrationTokenService)).toBeInstanceOf(ZoneRegistrationTokenService);
    expect(moduleRef.get(DeviceSecretService)).toBeInstanceOf(DeviceSecretService);
    expect(moduleRef.get(ZoneCryptoRepository)).toBeInstanceOf(ZoneCryptoRepository);
    expect(moduleRef.get(ZoneCryptoConfig)).toBeInstanceOf(ZoneCryptoConfig);
    expect(moduleRef.get(ContextService)).toBeInstanceOf(ContextService);

    await moduleRef.close();
  });
});
