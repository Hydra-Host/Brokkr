export interface UpdateDeviceTestRunInput {
  status: 'Completed';
  testPassed: boolean;
  data: Record<string, unknown>;
}
