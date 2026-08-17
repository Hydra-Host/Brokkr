import { APIKey, Session } from '@repo/auth';
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

export interface ApiKeyContext {
  authType: AuthType.ApiKey;
  apiKey: APIKey;
  user: User;
}

export type IdentityContext = (BaseIdentityContext & SessionContext) | (BaseIdentityContext & ApiKeyContext);
