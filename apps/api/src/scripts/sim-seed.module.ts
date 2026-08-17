import { Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';

import { DesignationOperatorPolicy, OPERATOR_POLICY } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { prefixesForLoggers } from 'src/common/decorators/logger.decorator';
import { DeviceSecretAuditService } from 'src/device-secret/device-secret-audit.service';
import { DeviceSecretService } from 'src/device-secret/device-secret.service';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { ZoneCryptoConfig } from 'src/zone-crypto/zone-crypto.config';
import { ZoneCryptoRepository } from 'src/zone-crypto/zone-crypto.repository';
import { ZoneRegistrationTokenService } from 'src/zone-crypto/zone-registration-token.service';

// tsx/esbuild emits no design:paramtypes, so every provider must use explicit useFactory + inject (order matching the constructor) — a reflected param deadlocks bootstrap with a silent exit 0.
const loggerToken = (name: string): string => `LoggerService${name}`;

class StderrLogger extends LoggerService {
  private prefix = 'sim-seed';
  override setContext(context: string): this {
    this.prefix = context;
    return this;
  }
  private emit(message: string, extra = ''): void {
    process.stderr.write(`[${this.prefix}] ${message}${extra}\n`);
  }
  override log(message: string): void {
    this.emit(message);
  }
  override warn(message: string): void {
    this.emit(message);
  }
  override error(message: string, trace?: string): void {
    this.emit(message, trace ? ` ${trace}` : '');
  }
  override debug(message: string): void {
    this.emit(message);
  }
  override verbose(message: string): void {
    this.emit(message);
  }
  // Base onModuleDestroy writes to stdout on app.close(), which would corrupt the mint token
  override async onModuleDestroy(): Promise<void> {}
}

const loggerTokenProviders: Provider[] = prefixesForLoggers.map((prefix) => ({
  provide: loggerToken(prefix),
  useFactory: (ctx: ContextService) => new StderrLogger(ctx).setContext(prefix),
  inject: [ContextService],
}));

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [
    ContextService,
    { provide: OPERATOR_POLICY, useClass: DesignationOperatorPolicy },
    ...loggerTokenProviders,
    {
      provide: PrismaClient,
      useFactory: (config: ConfigService) =>
        new PrismaClient({ adapter: new PrismaPg({ connectionString: config.getOrThrow<string>('DATABASE_URL') }) }),
      inject: [ConfigService],
    },
    {
      provide: ZoneCryptoConfig,
      useFactory: (config: ConfigService, logger: LoggerService) => new ZoneCryptoConfig(config, logger),
      inject: [ConfigService, loggerToken(ZoneCryptoConfig.name)],
    },
    {
      provide: ZoneCryptoRepository,
      useFactory: (prisma: PrismaClient) => new ZoneCryptoRepository(prisma),
      inject: [PrismaClient],
    },
    {
      provide: DeviceSecretAuditService,
      useFactory: (prisma: PrismaClient, logger: LoggerService) => new DeviceSecretAuditService(prisma, logger),
      inject: [PrismaClient, loggerToken(DeviceSecretAuditService.name)],
    },
    {
      provide: DeviceSecretService,
      useFactory: (
        prisma: PrismaClient,
        zoneCryptoConfig: ZoneCryptoConfig,
        zoneCryptoRepository: ZoneCryptoRepository,
        audit: DeviceSecretAuditService,
        logger: LoggerService,
      ) => new DeviceSecretService(prisma, zoneCryptoConfig, zoneCryptoRepository, audit, logger),
      inject: [
        PrismaClient,
        ZoneCryptoConfig,
        ZoneCryptoRepository,
        DeviceSecretAuditService,
        loggerToken(DeviceSecretService.name),
      ],
    },
    {
      provide: ZoneRegistrationTokenService,
      useFactory: (
        prisma: PrismaClient,
        repository: ZoneCryptoRepository,
        contextService: ContextService,
        logger: LoggerService,
      ) => new ZoneRegistrationTokenService(prisma, repository, contextService, logger),
      inject: [PrismaClient, ZoneCryptoRepository, ContextService, loggerToken(ZoneRegistrationTokenService.name)],
    },
  ],
})
export class SimSeedModule {}
