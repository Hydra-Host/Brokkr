import { apiKey } from '@better-auth/api-key';
import { API_PREFIX } from '@repo/api-client';
import { PrismaClient } from '@repo/database';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError } from 'better-auth/api';
import { organization, twoFactor } from 'better-auth/plugins';

import { deriveUserName } from './name.ts';
import { comparePassword, hashPassword } from './password.ts';

export {
  isGrantableApiKeyPermission,
  parseApiKeyPermissions,
  parseApiKeyPermissionScope,
  permissionKeysToRecord,
  resolveEffectiveApiKeyPermissions,
} from './api-key-permissions.ts';
export type { ApiKeyPermissionScope } from './api-key-permissions.ts';
export { BCRYPT_MAX_PASSWORD_BYTES, comparePassword, hashPassword } from './password.ts';
export { deriveUserName };

export interface SecondaryStorage {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: string, ttl?: number) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

export interface CreateAuthClientOptions {
  prismaClient: PrismaClient;
  trustedOrigins?: string[];
  secondaryStorage?: SecondaryStorage;
  sendResetPassword?: (data: { user: { email: string; name: string }; url: string; token: string }) => Promise<void>;
  /** Local-dev/automation only: trust every origin and disable CSRF. Passed explicitly by the host — this package never reads `process.env`, so the decision can't bypass the host's safety checks (apps/api/src/common/local-simulation.ts). */
  relaxOrigins?: boolean;
  minPasswordLength?: number;
  /** Local-dev/automation only: disable the rate limiter (parallel e2e workers trip the 5-per-minute sign-up cap). Gated by the host's auth-bypass policy — never relaxed in production. */
  relaxRateLimit?: boolean;
}

// Server-stamped header carrying Express's resolved `req.ip`. Better Auth would otherwise trust the client-spoofable leftmost `x-forwarded-for`/`cf-connecting-ip`; keying the limiter solely on this header makes the host-resolved IP the source of truth (see apps/api/src/auth/auth.controller.ts).
export const INTERNAL_CLIENT_IP_HEADER = 'x-brokkr-client-ip';

export const IP_ADDRESS_HEADERS: string[] = [INTERNAL_CLIENT_IP_HEADER];

export const createAuthClient = ({
  prismaClient,
  trustedOrigins = ['http://localhost:5173', 'http://localhost:3000'],
  secondaryStorage,
  sendResetPassword,
  relaxOrigins = false,
  minPasswordLength,
  relaxRateLimit = false,
}: CreateAuthClientOptions) => {
  return betterAuth({
    basePath: `${API_PREFIX}/auth`,
    advanced: {
      ipAddress: {
        ipAddressHeaders: IP_ADDRESS_HEADERS,
      },
      ...(relaxOrigins ? { disableCSRFCheck: true } : {}),
    },
    database: prismaAdapter(prismaClient, {
      provider: 'postgresql',
    }),
    trustedOrigins: relaxOrigins ? ['*'] : trustedOrigins,
    secondaryStorage,
    rateLimit: {
      enabled: !relaxRateLimit,
      window: 60,
      max: 100,
      ...(secondaryStorage ? { storage: 'secondary-storage' as const } : {}),
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 60, max: 5 },
        '/forget-password': { window: 60, max: 3 },
        '/request-password-reset': { window: 60, max: 3 },
      },
    },
    user: {
      additionalFields: {
        firstName: {
          type: 'string',
          required: true,
        },
        lastName: {
          type: 'string',
          required: true,
        },
      },
    },
    session: {
      storeSessionInDatabase: true,
      additionalFields: {
        activeOrganizationId: {
          type: 'string',
          required: false,
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      maxPasswordLength: 72,
      revokeSessionsOnPasswordReset: true,
      ...(minPasswordLength ? { minPasswordLength } : {}),
      password: {
        hash: async (password) => hashPassword(password),
        verify: async ({ hash, password }) => comparePassword(password, hash),
      },
      sendResetPassword: sendResetPassword
        ? async (data) => {
            await sendResetPassword({
              user: { email: data.user.email, name: data.user.name },
              url: data.url,
              token: data.token,
            });
          }
        : undefined,
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await prismaClient.user.findUnique({
              where: { id: session.userId },
              select: { banned: true, banExpires: true },
            });
            if (user?.banned && (!user.banExpires || user.banExpires > new Date())) {
              throw new APIError('FORBIDDEN', {
                message: 'There is an issue with your account, please contact support',
              });
            }
            return { data: session };
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            const { firstName, lastName } = deriveUserName(user);
            return {
              data: {
                ...user,
                firstName,
                lastName,
              },
            };
          },
        },
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        disableOrganizationDeletion: true,
      }),
      apiKey({
        defaultPrefix: 'brk_',
        enableMetadata: true,
        rateLimit: {
          enabled: true,
          timeWindow: 60 * 1000,
          maxRequests: 100,
        },
        schema: {
          apikey: {
            modelName: 'apiKey',
            fields: {
              referenceId: 'userId',
            },
          },
        },
      }),
      twoFactor({
        issuer: 'Brokkr',
      }),
    ],
  });
};

export type AuthClient = ReturnType<typeof createAuthClient>;
export type Session = AuthClient['$Infer']['Session'];
type VerifyApiKeyResult = Awaited<ReturnType<AuthClient['api']['verifyApiKey']>>;
type BaseApiKey = NonNullable<VerifyApiKeyResult['key']>;

export type APIKey = BaseApiKey & {
  organizationId: string;
};
