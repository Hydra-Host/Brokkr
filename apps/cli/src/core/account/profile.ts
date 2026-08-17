import { getSession as getStoredSession } from '../../config/store.js';
import { getSession } from '../auth.js';
import type { CliApiClient } from '../client.js';

export interface ProfileDetail {
  id: string;
  email: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export async function getProfile(): Promise<ProfileDetail> {
  try {
    const session = await getSession();
    return {
      id: session.userId,
      email: session.email,
      name: session.name,
      firstName: session.firstName,
      lastName: session.lastName,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  } catch {
    const stored = getStoredSession();
    if (!stored) throw new Error('Not logged in. Run: brokkr login');
    return {
      id: stored.userId,
      email: stored.email,
      name: null,
      firstName: null,
      lastName: null,
      createdAt: null,
      updatedAt: null,
    };
  }
}

export async function updateProfile(
  client: CliApiClient,
  data: { firstName?: string; lastName?: string },
): Promise<ProfileDetail> {
  const result = await client.updateUserProfile({ body: data });

  if (result.status !== 200) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to update profile (${result.status})`);
  }

  return getProfile();
}
