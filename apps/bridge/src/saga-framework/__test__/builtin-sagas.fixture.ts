
import { buildBenchmarksSaga } from '../../benchmarks/benchmarks.workflow';
import { buildInventoryCollectionSaga } from '../../collection/collection.workflow';
import { buildDeprovisionSaga } from '../../deprovision/deprovision.workflow';
import { buildDeviceHealthCheckSaga } from '../../device-health-check/device-health-check.workflow';
import { buildEnrichViaPxeSaga } from '../../enrich-via-pxe/enrich-via-pxe.workflow';
import { buildNetworkScanSaga } from '../../network-scan/network-scan.workflow';
import { buildCommissionSaga } from '../../commission/commission.workflow';
import { buildBmcResetSaga } from '../../power-ops/bmc-reset.workflow';
import { buildPowerOffSaga } from '../../power-ops/power-off.workflow';
import { buildPowerOnSaga } from '../../power-ops/power-on.workflow';
import { buildPowerStatusSaga } from '../../power-ops/power-status.workflow';
import { buildRebootSaga } from '../../power-ops/reboot.workflow';
import { buildProvisionSaga } from '../../provision/provision.workflow';
import { buildRedfishSaga } from '../../redfish-workflow/redfish.workflow';
import { buildSolSaga } from '../../sol-workflow/sol.workflow';
import { buildSyncSaga } from '../../sync/sync.workflow';
import type { SagaDef } from '../saga.types';

import { stubSagaStep } from './stub-saga-steps';

export const BENCHMARKS_SAGA = buildBenchmarksSaga({
  checkCcMode: stubSagaStep,
  runBenchmarks: stubSagaStep,
  reportResults: stubSagaStep,
});

export const BMC_RESET_SAGA = buildBmcResetSaga({
  pcValidateIpmi: stubSagaStep,
  pcBmcResetCold: stubSagaStep,
  pcVerifyBmcRecovery: stubSagaStep,
});

export const DEPROVISION_SAGA = buildDeprovisionSaga({
  disableOsBoot: stubSagaStep,
  ensureSolEnabled: stubSagaStep,
  solActivation: stubSagaStep,
  pcPowerOff: stubSagaStep,
  pcVerifyPowerOff: stubSagaStep,
  pcSetBootDevice: stubSagaStep,
  pcVerifyBootDevice: stubSagaStep,
  pcPowerOn: stubSagaStep,
  pcVerifyPowerOn: stubSagaStep,
  waitForBrokkrLive: stubSagaStep,
  wipeDisks: stubSagaStep,
  efiCleanup: stubSagaStep,
  collectHardware: stubSagaStep,
});

export const PROVISION_SAGA = buildProvisionSaga({
  brokkrLiveCheck: stubSagaStep,
  pcPowerOff: stubSagaStep,
  pcVerifyPowerOff: stubSagaStep,
  pcSetBootDevice: stubSagaStep,
  pcVerifyBootDevice: stubSagaStep,
  pcPowerOn: stubSagaStep,
  pcVerifyPowerOn: stubSagaStep,
  waitForBrokkrLive: stubSagaStep,
  disableOsBoot: stubSagaStep,
  teeConfig: stubSagaStep,
  waitForAgentSession: stubSagaStep,
  resolveDeployTarget: stubSagaStep,
  wipeDisks: stubSagaStep,
  prepareStorage: stubSagaStep,
  deployOs: stubSagaStep,
  armCustomIpxeBoot: stubSagaStep,
  ensureSolEnabled: stubSagaStep,
  solActivation: stubSagaStep,
  provisionComplete: stubSagaStep,
});

export const COMMISSION_SAGA = buildCommissionSaga({
  validateIpmi: stubSagaStep,
  redfishStandardize: stubSagaStep,
  brokkrLiveCheck: stubSagaStep,
  disableOsBoot: stubSagaStep,
  pcPowerOff: stubSagaStep,
  pcVerifyPowerOff: stubSagaStep,
  pcSetBootDevice: stubSagaStep,
  pcVerifyBootDevice: stubSagaStep,
  pcPowerOn: stubSagaStep,
  pcVerifyPowerOn: stubSagaStep,
  waitForBrokkrLive: stubSagaStep,
  waitForAgentSession: stubSagaStep,
  wipeDisks: stubSagaStep,
  collectHardware: stubSagaStep,
});

export const REDFISH_SAGA = buildRedfishSaga({ redfishCommand: stubSagaStep });

export const SOL_SAGA = buildSolSaga({
  ensureSolEnabled: stubSagaStep,
  deactivateSol: stubSagaStep,
  solMonitor: stubSagaStep,
});

export const NETWORK_SCAN_SAGA = buildNetworkScanSaga({ networkScan: stubSagaStep });

export const INVENTORY_COLLECTION_SAGA = buildInventoryCollectionSaga({
  waitForBrokkrLive: stubSagaStep,
  collectHardware: stubSagaStep,
  probeSerialPort: stubSagaStep,
});

export const SYNC_SAGA = buildSyncSaga({ sync: stubSagaStep });

export const REBOOT_SAGA = buildRebootSaga({
  pcValidateIpmi: stubSagaStep,
  pcPowerOff: stubSagaStep,
  pcVerifyPowerOff: stubSagaStep,
  pcSetBootDevice: stubSagaStep,
  pcVerifyBootDevice: stubSagaStep,
  pcPowerOn: stubSagaStep,
  pcVerifyPowerOn: stubSagaStep,
  pcWaitForOs: stubSagaStep,
});

export const POWER_ON_SAGA = buildPowerOnSaga({
  pcValidateIpmi: stubSagaStep,
  pcSetBootDevice: stubSagaStep,
  pcVerifyBootDevice: stubSagaStep,
  pcPowerOn: stubSagaStep,
  pcVerifyPowerOn: stubSagaStep,
  pcWaitForOs: stubSagaStep,
});

export const POWER_OFF_SAGA = buildPowerOffSaga({
  pcValidateIpmi: stubSagaStep,
  pcPowerOff: stubSagaStep,
  pcVerifyPowerOff: stubSagaStep,
});

export const POWER_STATUS_SAGA = buildPowerStatusSaga({ pcValidateIpmi: stubSagaStep });

export const DEVICE_HEALTH_CHECK_SAGA = buildDeviceHealthCheckSaga({ checkDevice: stubSagaStep });

export const ENRICH_VIA_PXE_SAGA = buildEnrichViaPxeSaga({
  redfishCommand: stubSagaStep,
  ensureLanplusAccess: stubSagaStep,
  pcValidateIpmi: stubSagaStep,
  pcPowerOff: stubSagaStep,
  pcVerifyPowerOff: stubSagaStep,
  pcSetBootDevice: stubSagaStep,
  pcVerifyBootDevice: stubSagaStep,
  pcPowerOn: stubSagaStep,
  pcVerifyPowerOn: stubSagaStep,
});

export const BUILTIN_SAGAS: ReadonlyArray<SagaDef> = [
  BENCHMARKS_SAGA,
  BMC_RESET_SAGA,
  DEPROVISION_SAGA,
  PROVISION_SAGA,
  COMMISSION_SAGA,
  REDFISH_SAGA,
  SOL_SAGA,
  NETWORK_SCAN_SAGA,
  INVENTORY_COLLECTION_SAGA,
  SYNC_SAGA,
  REBOOT_SAGA,
  POWER_ON_SAGA,
  POWER_OFF_SAGA,
  POWER_STATUS_SAGA,
  DEVICE_HEALTH_CHECK_SAGA,
  ENRICH_VIA_PXE_SAGA,
];
