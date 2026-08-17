import type { Device, Gpu, MemoryConfig, Server } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';
import { MIB_PER_GIB } from '@repo/utils';

type DeviceField = ModelFieldPaths<Device, { server: Server; gpus: Gpu; memoryConfig: MemoryConfig }>;

export const devicesPaginationConfig = createPaginationConfig<DeviceField>({
  searchableFields: [],
  filterFields: {
    role: 'role',
    status: 'status',
  },
  sortableFields: {
    name: 'name',
    nickname: 'nickname',
    status: 'status',
    gpuCount: 'gpus._count',
    memory: 'memoryConfig.totalSizeMb',
    isListed: 'server.isListed',
    hourlyPrice: { field: 'server.hourlyPrice', nullsLast: true },
    createdAt: 'createdAt',
  },
  defaultSort: [{ field: 'name', direction: 'asc' }],
  advancedFilterFields: {
    role: {
      prismaField: 'role',
      type: 'enum',
      allowedValues: ['Baremetal', 'DiscoveredHost', 'OffMarketplaceHost', 'Decommissioned'],
    },
    status: { prismaField: 'status', type: 'string' },
    gpuModel: { prismaField: 'gpus.some.model', type: 'string' },
    memory: { prismaField: 'memoryConfig.totalSizeMb', type: 'number', valueMultiplier: MIB_PER_GIB },
    name: { prismaField: 'name', type: 'string' },
    nickname: { prismaField: 'nickname', type: 'string' },
    createdAt: { prismaField: 'createdAt', type: 'date' },
  },
});
