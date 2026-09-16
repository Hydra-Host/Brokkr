import { useSession } from '@repo/auth/client';
import { isRecord } from '@repo/utils';

export function useActiveOrganizationId(): string | undefined {
  const { data: session } = useSession();
  return isRecord(session?.session) && typeof session.session.activeOrganizationId === 'string'
    ? session.session.activeOrganizationId
    : undefined;
}
