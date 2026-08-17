import { APIError } from 'better-auth/api';

export function deriveUserName(user: { name?: string | null; firstName?: string; lastName?: string }): {
  firstName: string;
  lastName: string;
} {
  const parts = user.name?.trim().split(/\s+/).filter(Boolean) ?? [];
  const firstName = user.firstName ?? parts[0];
  if (!firstName) {
    throw new APIError('BAD_REQUEST', { message: 'A name is required to create a user.' });
  }
  const lastName = user.lastName ?? (parts.slice(1).join(' ') || parts[0] || firstName);
  return { firstName, lastName };
}
