import type { Interface } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type InterfaceField = ModelFieldPaths<Interface>;

export const interfacePaginationConfig = createPaginationConfig<InterfaceField>({
  searchableFields: ['name', 'macAddress', 'description', 'guid', 'lldpNeighborName', 'lldpNeighborMgmtIp'],
  filterFields: {
    deviceId: 'deviceId',
    type: 'type',
    enabled: 'enabled',
    linkType: 'linkType',
  },
  sortableFields: {
    name: 'name',
    type: 'type',
    enabled: 'enabled',
    mtu: 'mtu',
    speed: 'speed',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
  defaultPageSize: 50,
});
