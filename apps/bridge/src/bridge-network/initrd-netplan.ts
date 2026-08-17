import { NIL_DEVICE_ID } from '../constants';

import type { NetplanAtomService } from './netplan-atom.service';

import { getLogger } from '../logger/logger.service';

export const INITRD_NETPLAN_TIMEOUT_S = 30;

export interface FetchLiveNetplanForInitrdOptions {
  jobId?: string;
}

export async function fetchLiveNetplanForInitrd(
  netplanAtom: NetplanAtomService,
  deviceId: string,
  options: FetchLiveNetplanForInitrdOptions = {},
): Promise<string> {
  const { jobId = '' } = options;
  if (!deviceId || deviceId === NIL_DEVICE_ID) return '';
  try {
    return (
      (await netplanAtom.getLiveNetplan(deviceId, {
        jobId,
        timeoutS: INITRD_NETPLAN_TIMEOUT_S,
      })) ?? ''
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    void getLogger().warning(`Failed to fetch live netplan for device ${deviceId}: ${msg} job=${jobId}`);
    return '';
  }
}
