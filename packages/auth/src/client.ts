import { API_PREFIX } from '@repo/api-client';
import { adminClient, inferAdditionalFields, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import type { AuthClient } from './index.ts';

export const authClient = createAuthClient({
  basePath: `${API_PREFIX}/auth`,
  fetchOptions: {
    onError: async (context) => {
      if (context.response.status === 429) {
        const retryAfter = context.response.headers.get('X-Retry-After');
        throw new Error(
          retryAfter
            ? `Too many requests. Please try again in ${retryAfter} seconds.`
            : 'Too many requests. Please try again later.',
        );
      }
    },
  },
  plugins: [
    adminClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        const url = new URL('/auth/two-factor', window.location.origin);
        const redirect = new URLSearchParams(window.location.search).get('redirect');
        if (redirect) url.searchParams.set('redirect', redirect);
        window.location.href = url.toString();
      },
    }),
    inferAdditionalFields<AuthClient>(),
  ],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  admin,
  twoFactor,
  requestPasswordReset,
  resetPassword,
  revokeOtherSessions,
} = authClient;
