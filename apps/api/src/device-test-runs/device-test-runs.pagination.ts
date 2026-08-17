import type { Device, DeviceTestRun } from '@repo/database';
import { createPaginationConfig, type ModelFieldPaths } from '@repo/database/pagination';

type DeviceTestRunField = ModelFieldPaths<DeviceTestRun, { device: Device }>;

export const deviceTestRunsPaginationConfig = createPaginationConfig<DeviceTestRunField>({
  searchableFields: ['device.name', 'device.id'],
  filterFields: {
    deviceId: 'deviceId',
    type: 'type',
    status: 'status',
  },
  sortableFields: {
    deviceId: 'deviceId',
    type: 'type',
    status: 'status',
    startTime: 'startTime',
    durationSeconds: 'durationSeconds',
    testPassed: 'testPassed',
  },
  defaultSort: [{ field: 'startTime', direction: 'desc' }],
  defaultPageSize: 25,
});
