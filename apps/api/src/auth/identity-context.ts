import { Session } from '@repo/auth';
import { Member, Organization, OrganizationMembershipRole, User } from '@repo/database';

export enum AuthType {
  Session = 'session',
  ApiKey = 'api-key',
}

export interface BaseIdentityContext {
  role: OrganizationMembershipRole;
  assignedRoleId: string;
  permissions: ReadonlySet<string>;
  organizationId: string;
  organization: Organization & { members: Member[] };
}

export interface SessionContext {
  authType: AuthType.Session;
  session: Session;
}

export interface ApiKeyPayload {
  id: string;
  name?: string | null;
  referenceId: string;
  organizationId: string;
}

export interface ApiKeyContext {
  authType: AuthType.ApiKey;
  apiKey: ApiKeyPayload;
  user: User;
}

export type IdentityContext = (BaseIdentityContext & SessionContext) | (BaseIdentityContext & ApiKeyContext);
