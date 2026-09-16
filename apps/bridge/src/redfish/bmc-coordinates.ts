import { ipInCidr } from '@repo/utils';
import { type RedfishConfig, buildRedfishConfig } from './redfish.config.js';

export interface BmcCoordinates {
  readonly protocol: 'http' | 'https';
  readonly port: number;
}

function realBmc(config: RedfishConfig): BmcCoordinates {
  return { protocol: 'https', port: config.realRedfishPort };
}

export function bmcCoordinates(bmcIp: string, env: NodeJS.ProcessEnv = process.env): BmcCoordinates {
  const config = buildRedfishConfig(env);
  if (!config.localSimulationEnabled) return realBmc(config);
  if (config.simBmcCidr !== null && !ipInCidr(bmcIp, config.simBmcCidr)) return realBmc(config);
  return { protocol: 'http', port: config.simRedfishPort };
}

export function redfishProbeCoordinates(ip: string, env: NodeJS.ProcessEnv = process.env): BmcCoordinates[] {
  const coords = bmcCoordinates(ip, env);
  return coords.protocol === 'http' ? [realBmc(buildRedfishConfig(env)), coords] : [coords];
}
