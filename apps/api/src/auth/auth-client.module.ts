import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { createAuthClient, type SecondaryStorage } from '@repo/auth';
import { ContextModule } from 'src/common/context/context.module';
import { BYPASS_MIN_PASSWORD_LENGTH, resolveAuthBypassPolicy } from 'src/common/local-simulation';
import { EmailModule } from 'src/email/email.module';
import { EmailService } from 'src/email/email.service';
import { PrismaModule } from 'src/prisma';
import { PrismaClient } from 'src/prisma/prisma.client';
import { AuthRepository } from './auth.repo';
import { createRedisSecondaryStorage, type RedisSecondaryStorageHandle } from './redis-secondary-storage';

const AUTH_SESSION_CACHE_HANDLE = 'AUTH_SESSION_CACHE_HANDLE';

function deriveTrustedOrigins(): string[] {
  const origins: string[] = [];

  const baseUrl = process.env.BASE_URL?.trim();
  if (baseUrl) {
    try {
      origins.push(new URL(baseUrl).origin);
    } catch {
      origins.push(baseUrl);
    }
  }

  origins.push(
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  origins.push('http://localhost:5173', 'http://localhost:3000');

  return [...new Set(origins)];
}

@Module({
  imports: [PrismaModule, ContextModule, EmailModule],
  providers: [
    AuthRepository,
    {
      provide: AUTH_SESSION_CACHE_HANDLE,
      useFactory: (): RedisSecondaryStorageHandle | null => createRedisSecondaryStorage() ?? null,
    },
    {
      provide: 'AUTH_SESSION_CACHE',
      useFactory: (handle: RedisSecondaryStorageHandle | null): SecondaryStorage | null => handle?.storage ?? null,
      inject: [AUTH_SESSION_CACHE_HANDLE],
    },
    {
      provide: 'AUTH_CLIENT',
      useFactory: (prismaClient: PrismaClient, emailService: EmailService, sessionCache: SecondaryStorage | null) => {
        const bypass = resolveAuthBypassPolicy();
        return createAuthClient({
          prismaClient,
          secondaryStorage: sessionCache ?? undefined,
          relaxOrigins: bypass.relaxOrigins,
          trustedOrigins: deriveTrustedOrigins(),
          minPasswordLength: bypass.relaxPasswordPolicy ? BYPASS_MIN_PASSWORD_LENGTH : undefined,
          relaxRateLimit: bypass.relaxRateLimit,
          sendResetPassword: async ({ user, url }) => {
            const firstName = user.name?.split(' ')[0] || 'there';
            await emailService.send.passwordReset({
              email: user.email,
              firstName,
              url,
            });
          },
        });
      },
      inject: [PrismaClient, EmailService, 'AUTH_SESSION_CACHE'],
    },
  ],
  exports: ['AUTH_CLIENT', 'AUTH_SESSION_CACHE', AuthRepository],
})
export class AuthClientModule implements OnModuleDestroy {
  constructor(
    @Inject(AUTH_SESSION_CACHE_HANDLE)
    private readonly sessionCacheHandle: RedisSecondaryStorageHandle | null,
  ) {}

  async onModuleDestroy() {
    await this.sessionCacheHandle?.close();
  }
}
