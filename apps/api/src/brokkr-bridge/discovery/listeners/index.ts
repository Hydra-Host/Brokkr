import type { Type } from '@nestjs/common';
import { DiscoveryBenchmarksListener } from './discovery-benchmarks.listener';
import { DiscoveryDeviceRecordListener } from './discovery-device-record.listener';
import { DiscoveryQualifyListener } from './discovery-qualify.listener';

export const DISCOVERY_LISTENERS: Type<object>[] = [
  DiscoveryQualifyListener,
  DiscoveryBenchmarksListener,
  DiscoveryDeviceRecordListener,
];

export { DiscoveryBenchmarksListener, DiscoveryDeviceRecordListener, DiscoveryQualifyListener };
