import { benchmarksSagaPayloadSchema } from '../benchmarks/benchmarks.schema';
import { inventoryCollectionSagaPayloadSchema } from '../collection/collection.schema';
import { commissionSagaPayloadSchema } from '../commission/commission.schema';
import { deprovisionSagaPayloadSchema } from '../deprovision/deprovision.schema';
import { deviceHealthCheckSagaPayloadSchema } from '../device-health-check/device-health-check.schema';
import { networkScanSagaPayloadSchema } from '../network-scan/network-scan.schema';
import { bmcResetSagaPayloadSchema } from '../power-ops/bmc-reset.schema';
import { powerOffSagaPayloadSchema } from '../power-ops/power-off.schema';
import { powerOnSagaPayloadSchema } from '../power-ops/power-on.schema';
import { powerStatusSagaPayloadSchema } from '../power-ops/power-status.schema';
import { rebootSagaPayloadSchema } from '../power-ops/reboot.schema';
import { provisionSagaPayloadSchema } from '../provision/provision.schema';
import { redfishSagaPayloadSchema } from '../redfish-workflow/redfish.schema';
import { solSagaPayloadSchema } from '../sol-workflow/sol.schema';
import { syncSagaPayloadSchema } from '../sync/sync.schema';

import type { SagaPayloadSchemaRegistry } from './saga-payload-validate';

export const SAGA_PAYLOAD_SCHEMA_REGISTRY = 'SAGA_PAYLOAD_SCHEMA_REGISTRY';

export const productionSagaPayloadSchemaRegistry: SagaPayloadSchemaRegistry = {
  benchmarks: benchmarksSagaPayloadSchema,
  bmc_reset: bmcResetSagaPayloadSchema,
  deprovision: deprovisionSagaPayloadSchema,
  device_health_check: deviceHealthCheckSagaPayloadSchema,
  inventory_collection: inventoryCollectionSagaPayloadSchema,
  network_scan: networkScanSagaPayloadSchema,
  commission: commissionSagaPayloadSchema,
  power_off: powerOffSagaPayloadSchema,
  power_on: powerOnSagaPayloadSchema,
  power_status: powerStatusSagaPayloadSchema,
  provision: provisionSagaPayloadSchema,
  reboot: rebootSagaPayloadSchema,
  redfish: redfishSagaPayloadSchema,
  sol: solSagaPayloadSchema,
  sync: syncSagaPayloadSchema,
};
