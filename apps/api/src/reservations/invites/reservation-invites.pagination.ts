import type { Organization, ReservationInvite } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type ReservationInviteField = ModelFieldPaths<ReservationInvite, { inviteeOrganization: Organization }>;

export const reservationInvitesPaginationConfig = createPaginationConfig<ReservationInviteField>({
  searchableFields: ['inviteeEmail', 'inviterEmail', 'inviteeOrganization.name', 'notes'],
  filterFields: {},
  sortableFields: {
    dateCreated: 'dateCreated',
    dateExpires: 'dateExpires',
    price: 'price',
    billingFrequency: 'billingFrequency',
  },
  defaultSort: [{ field: 'dateCreated', direction: 'desc' }],
  defaultPageSize: 25,
});
