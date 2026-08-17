import type { PaginationConfig } from '@repo/database/pagination';

export const bridgesPaginationConfig: PaginationConfig = {
  searchableFields: ['name', 'status', 'type', 'datacenter.name', 'zone.name'],
  filterFields: {},
  sortableFields: {
    name: 'name',
    status: 'status',
    type: 'type',
    datacenterName: 'datacenter.name',
    zoneName: 'zone.name',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
  advancedFilterFields: {
    status: { prismaField: 'status', type: 'string' },
    type: {
      prismaField: 'type',
      type: 'enum',
      allowedValues: ['managed', 'self-hosted'],
    },
    datacenterName: { prismaField: 'datacenter.name', type: 'string' },
    zoneName: { prismaField: 'zone.name', type: 'string' },
  },
};
