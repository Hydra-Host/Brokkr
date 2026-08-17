import { RequestSource } from '@repo/database';

export type RescueOperatingSystemSlug = 'ubuntu-rescue-os';

export const RESCUE_OS_SLUG: RescueOperatingSystemSlug = 'ubuntu-rescue-os';

export interface PowerControlDeploymentJob {
  jobId: string;
  userId: string;
  organizationId: string;
  deviceId: string;
  deviceMetadataId: number | null;
  operation: 'on' | 'off';
  source: RequestSource;
}
