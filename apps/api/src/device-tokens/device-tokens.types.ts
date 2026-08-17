import { DeviceTokenContext } from '@repo/database';

export interface DeviceIdentityContext {
  deviceId: string;
  context: DeviceTokenContext;
  tokenId: string;
  supplierId: string | null;
  zoneId: string | null;
  systemUuid: string | null;
  deploymentId?: string | null;
}

export interface DeploymentOsTokenMaterial {
  deployment_os_token: string;
  endpoint: string;
}

export interface BrokkrLiveTokenMaterial {
  brokkr_live_token: string;
  endpoint: string;
  exp: number;
}

export interface IssuedDeviceToken<TMaterial extends DeploymentOsTokenMaterial | BrokkrLiveTokenMaterial> {
  tokenId: string;
  displayId: string;
  plaintext: string | null;
  material: TMaterial | null;
  reused: boolean;
}
