import { UnauthorizedException } from '@nestjs/common';

export function readHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

export function extractBearerToken(headerValue: string | string[] | undefined): string {
  const header = readHeaderValue(headerValue);
  if (!header) {
    throw new UnauthorizedException('Missing bearer token');
  }

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new UnauthorizedException('Invalid authorization header');
  }

  return token;
}
