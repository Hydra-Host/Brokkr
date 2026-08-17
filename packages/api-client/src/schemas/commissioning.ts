import { z } from 'zod';

export const CommissioningScanRequestSchema = z.object({
  subnets: z
    .array(z.string().cidr({ message: 'Each subnet must be a valid CIDR (e.g. 10.0.0.0/24)' }))
    .min(1)
    .max(50)
    .optional()
    .describe('Optional CIDR override; when omitted, every MANAGEMENT prefix of the zone is scanned'),
});
export type CommissioningScanRequest = z.infer<typeof CommissioningScanRequestSchema>;

export const CommissioningScanResponseSchema = z.object({
  sessionId: z.string().describe('Scan-session id used to poll aggregated results across all scanned subnets'),
  subnets: z.array(z.string()).describe('The CIDR subnets that were enqueued for scanning'),
});
export type CommissioningScanResponse = z.infer<typeof CommissioningScanResponseSchema>;

export const CommissioningManagementSubnetsResponseSchema = z.object({
  subnets: z
    .array(z.string().describe('A MANAGEMENT prefix of the zone, as a normalized CIDR (e.g. "10.99.1.0/24")'))
    .describe("The zone's MANAGEMENT prefixes, used to populate the commissioning scan-target selector"),
});
export type CommissioningManagementSubnetsResponse = z.infer<typeof CommissioningManagementSubnetsResponseSchema>;

export const ScannedDeviceSchema = z.object({
  id: z.null().describe('Always null for newly discovered devices'),
  bmcMac: z.string().describe('BMC interface MAC address'),
  bmcIp: z.string().describe('BMC IP address discovered via scan'),
  nicMac: z.string().describe('NIC MAC from iPXE pending data enrichment'),
  nicIp: z.string().describe('NIC IP from iPXE pending data enrichment'),
  hasIpmi: z.boolean().describe('Whether IPMI was detected on this device'),
  hasRedfish: z.boolean().describe('Whether Redfish was detected on this device'),
  serial: z.string().describe('Serial number from iPXE pending data enrichment'),
  boardSerial: z.string().describe('Board serial from iPXE pending data enrichment'),
  chassisSerial: z.string().describe('Chassis serial from iPXE pending data enrichment'),
  manufacturer: z.string().describe('Manufacturer from iPXE pending data enrichment'),
  enriched: z.boolean().describe('Whether this device was enriched with iPXE pending data'),
  commissioningStatus: z
    .enum(['Detected', 'InProgress', 'Done', 'Failed'])
    .describe('State for the scanned device, derived from a matched in-progress/commissioned device'),
});
export type ScannedDevice = z.infer<typeof ScannedDeviceSchema>;

export const CommissioningScanPollResponseSchema = z.object({
  status: z.enum(['pending', 'complete', 'failed']).describe('Aggregated scan status across the session'),
  result: z
    .object({
      devices: z.array(ScannedDeviceSchema).describe('New (not-yet-registered) devices discovered by the scan'),
      total: z.number().describe('Total number of discovered devices'),
      partial: z.boolean().describe('True when one or more subnet scans failed, so the device list may be incomplete'),
      subnetsTotal: z.number().describe('Number of subnets the session attempted to scan'),
      subnetsFailed: z.number().describe('Number of subnets whose scan failed and were omitted from the results'),
    })
    .optional()
    .describe('Scan results, present when status is complete (may be partial — check the partial flag)'),
  error: z.string().optional().describe('Error message when status is failed'),
});
export type CommissioningScanPollResponse = z.infer<typeof CommissioningScanPollResponseSchema>;

export const CommissioningEnrichRequestSchema = z.object({
  bmcIp: z.string().describe('BMC IP address to enrich'),
  bmcUsername: z.string().describe('BMC username used to reach the BMC'),
  bmcPassword: z.string().describe('BMC password used to reach the BMC'),
});
export type CommissioningEnrichRequest = z.infer<typeof CommissioningEnrichRequestSchema>;

export const CommissioningEnrichResponseSchema = z.object({
  success: z.boolean().describe('Whether the enrich_via_pxe saga was enqueued'),
  planId: z
    .string()
    .describe('Plan id of the enqueued enrich_via_pxe saga; poll its status via the enrich-status endpoint'),
});
export type CommissioningEnrichResponse = z.infer<typeof CommissioningEnrichResponseSchema>;

export const CommissioningEnrichStatusResponseSchema = z.object({
  status: z
    .enum(['pending', 'complete', 'failed', 'expired'])
    .describe(
      'Enrich saga status from the bridge plan: pending (in flight), complete, failed, or expired ' +
        '(the plan is gone past its grace window or was cancelled — the device never booted brokkr-live).',
    ),
  error: z.string().nullable().describe('Failure detail (e.g. the failed step error) when status is failed'),
});
export type CommissioningEnrichStatusResponse = z.infer<typeof CommissioningEnrichStatusResponseSchema>;

export const CommissioningRefreshEnrichmentRequestSchema = z.object({
  devices: z.array(ScannedDeviceSchema).describe('Scanned devices to re-check against iPXE pending data'),
});
export type CommissioningRefreshEnrichmentRequest = z.infer<typeof CommissioningRefreshEnrichmentRequestSchema>;

export const CommissioningRefreshEnrichmentResponseSchema = z.object({
  devices: z
    .array(ScannedDeviceSchema)
    .describe('The submitted devices with NIC MAC/serial enrichment fields refreshed from iPXE pending data'),
});
export type CommissioningRefreshEnrichmentResponse = z.infer<typeof CommissioningRefreshEnrichmentResponseSchema>;

export const CommissioningDeviceInputSchema = z.object({
  bmcMac: z.string().describe('BMC MAC address'),
  bmcIp: z.string().describe('BMC IP address'),
  bmcUsername: z.string().describe('BMC username'),
  bmcPassword: z.string().describe('BMC password'),
  nicMac: z.string().optional().describe('Boot NIC MAC from iPXE pending data enrichment'),
  nicIp: z.string().optional().describe('Boot NIC IP from iPXE pending data enrichment (PXE-time IP)'),
  osIp: z
    .string()
    .optional()
    .describe('Operator-supplied primary OS IP for eth0; supersedes the PXE-time NIC IP when set'),
  serial: z.string().optional().describe('Device serial number from iPXE pending data enrichment'),
});
export type CommissioningDeviceInput = z.infer<typeof CommissioningDeviceInputSchema>;

export const CommissioningValidateRequestSchema = z.object({
  devices: z
    .array(CommissioningDeviceInputSchema)
    .describe('Devices to validate (IPMI connectivity) before commissioning'),
});
export type CommissioningValidateRequest = z.infer<typeof CommissioningValidateRequestSchema>;

const IpmiTestResultSchema = z.object({
  bmcIp: z.string().describe('BMC IP tested'),
  success: z.boolean().describe('Whether the test passed'),
  message: z.string().describe('Detail message'),
});

export const CommissioningValidateResponseSchema = z.object({
  success: z.boolean().describe('Whether validation completed'),
  message: z.string().describe('Status message'),
  ipmiTestResults: z.array(IpmiTestResultSchema).describe('IPMI connectivity test results per device'),
  totalDevices: z.number().describe('Total number of devices tested'),
  successfulTests: z.number().describe('Number of devices that passed IPMI validation'),
  failedTests: z.number().describe('Number of devices that failed IPMI validation'),
});
export type CommissioningValidateResponse = z.infer<typeof CommissioningValidateResponseSchema>;

export const CommissioningDevicesRequestSchema = z.object({
  devices: z.array(CommissioningDeviceInputSchema).describe('Devices to commission with credentials'),
});
export type CommissioningDevicesRequest = z.infer<typeof CommissioningDevicesRequestSchema>;

export const CommissioningRetryRequestSchema = z.object({
  device: CommissioningDeviceInputSchema.describe(
    'The device to re-commission. Retry soft-deletes the failed commissioning device and commissions a fresh one, so the BMC credentials must be re-supplied (the prior sealed creds are zone-bound and invalidated on soft-delete).',
  ),
});
export type CommissioningRetryRequest = z.infer<typeof CommissioningRetryRequestSchema>;

export const CommissioningDevicesResponseSchema = z.object({
  success: z.boolean().describe('Whether at least one device began commissioning'),
  message: z.string().describe('Status message'),
  processedDevices: z.number().describe('Number of devices in the request'),
  createdCount: z.number().describe('Number of devices that began commissioning'),
  failedCount: z.number().describe('Number of devices that failed to start'),
  deviceIds: z.array(z.string()).describe('Brokkr Device UUIDs created (role=null commissioning records)'),
  failedDevices: z
    .array(z.object({ bmcMac: z.string().describe('Device BMC MAC'), error: z.string().describe('Failure reason') }))
    .optional()
    .describe('Devices that failed to start, with reasons'),
});
export type CommissioningDevicesResponse = z.infer<typeof CommissioningDevicesResponseSchema>;

export const SagaStepSchema = z.object({
  name: z.string().describe('Step identifier (e.g. "reboot_to_live", "disk_wipe")'),
  operation: z.string().describe('Human-readable operation description'),
  status: z.string().describe('Step status: pending, running, complete, or failed'),
  phase: z.string().describe('Saga phase: commission, provision, or deprovision'),
  startedAt: z.string().nullable().describe('ISO timestamp when the step started'),
  completedAt: z.string().nullable().describe('ISO timestamp when the step completed'),
  error: z.string().nullable().describe('Error message if the step failed'),
});
export type SagaStep = z.infer<typeof SagaStepSchema>;

export const CommissioningProgressItemSchema = z.object({
  deviceId: z.string().describe('Brokkr Device UUID (the commissioning record; role=null until acknowledged)'),
  bmcMac: z.string().nullable().describe('BMC MAC address'),
  bmcIp: z.string().nullable().describe('BMC IP address (host, no mask)'),
  nicMac: z.string().nullable().describe('Boot NIC (eth0) MAC address'),
  nicIp: z.string().nullable().describe('Boot NIC (eth0) IP address (host, no mask)'),
  serial: z.string().nullable().describe('Device system serial'),
  deviceStatus: z.string().describe('Device.status (PLANNED/ACTIVE/…)'),
  zoneId: z.string().nullable().describe('Zone the device is being commissioned into'),
  zoneOnline: z.boolean().describe('Whether the zone bridge is currently online (ZoneStatus.isOnline)'),
  lifecycleFailed: z.boolean().describe('Durable terminal-failure marker (Server.lifecycleStatus === FAILED)'),
  lifecycleQualified: z
    .boolean()
    .describe(
      'Durable qualified marker (Server.lifecycleStatus === INVENTORY); drives Done independent of Redis saga steps',
    ),
  sagaSteps: z.array(SagaStepSchema).describe('Per-step saga progress from the bridge (Redis plan steps)'),
  createdAt: z.string().describe('ISO timestamp the commissioning device was created'),
  updatedAt: z.string().describe('ISO timestamp of last device update (bumped on retry; stall baseline)'),
});
export type CommissioningProgressItem = z.infer<typeof CommissioningProgressItemSchema>;

export const CommissioningProgressResponseSchema = z.object({
  success: z.boolean().describe('Whether the progress fetch succeeded'),
  data: z.array(CommissioningProgressItemSchema).optional().describe('Commissioning devices (role=null) for the zone'),
  message: z.string().optional().describe('Status message'),
});
export type CommissioningProgressResponse = z.infer<typeof CommissioningProgressResponseSchema>;

export const CommissioningActionResponseSchema = z.object({
  success: z.boolean().describe('Whether the action succeeded'),
  message: z.string().describe('Human-readable status message'),
});
export type CommissioningActionResponse = z.infer<typeof CommissioningActionResponseSchema>;
