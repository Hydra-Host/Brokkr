import { describe, expect, it } from 'vitest';
import { deriveTrustedOrigins, toWebOriginResetLink } from 'src/auth/auth-client.module';

const API_PREFIX = '/api/v1';
const API_ORIGIN = 'http://localhost:3000';
const WEB_ORIGIN = 'http://localhost:5173';
const TOKEN = 'X3sT0k3nX3sT0k3nX3sT0k3n';
const SPA_RESET_ROUTE = '/auth/reset-password';

function emittedResetLink(redirectTo: string): string {
  return `${API_ORIGIN}${API_PREFIX}/auth/reset-password/${TOKEN}?callbackURL=${encodeURIComponent(redirectTo)}`;
}

describe('password reset link', () => {
  it('keeps the emitted link untouched when WEB_BASE_URL is unset', () => {
    const emitted = emittedResetLink(SPA_RESET_ROUTE);

    expect(toWebOriginResetLink(emitted, {})).toBe(emitted);
    expect(new URL(toWebOriginResetLink(emitted, {})).origin).toBe(API_ORIGIN);
  });

  it('roots the emitted link at the web origin and keeps the token path', () => {
    const link = new URL(toWebOriginResetLink(emittedResetLink(SPA_RESET_ROUTE), { WEB_BASE_URL: WEB_ORIGIN }));

    expect(link.origin).toBe(WEB_ORIGIN);
    expect(link.pathname).toBe(`${API_PREFIX}/auth/reset-password/${TOKEN}`);
  });

  it('lands the callback on the SPA reset-password route', () => {
    const link = new URL(toWebOriginResetLink(emittedResetLink(SPA_RESET_ROUTE), { WEB_BASE_URL: WEB_ORIGIN }));
    const callback = new URL(link.searchParams.get('callbackURL') ?? '');

    expect(callback.origin).toBe(WEB_ORIGIN);
    expect(callback.pathname).toBe(SPA_RESET_ROUTE);
  });

  it('leaves an absolute callback pointing at the web origin alone', () => {
    const emitted = emittedResetLink(`${WEB_ORIGIN}${SPA_RESET_ROUTE}`);
    const link = new URL(toWebOriginResetLink(emitted, { WEB_BASE_URL: WEB_ORIGIN }));

    expect(link.searchParams.get('callbackURL')).toBe(`${WEB_ORIGIN}/auth/reset-password`);
  });

  it('returns the emitted link unchanged when WEB_BASE_URL is not a URL', () => {
    const emitted = emittedResetLink(SPA_RESET_ROUTE);

    expect(toWebOriginResetLink(emitted, { WEB_BASE_URL: 'not-a-url' })).toBe(emitted);
  });

  it('trusts the web origin so better-auth accepts an absolute redirect to it', () => {
    const origins = deriveTrustedOrigins({ BASE_URL: API_ORIGIN, WEB_BASE_URL: 'https://app.example.com/' });

    expect(origins).toContain('https://app.example.com');
    expect(origins).toContain(API_ORIGIN);
  });
});
