import { Member, Organization, User } from '@repo/database';

export type MemberWithOrganization = Member & {
  organization: Organization;
};

export type UserWithOrganizations = User & {
  members: MemberWithOrganization[];
};
