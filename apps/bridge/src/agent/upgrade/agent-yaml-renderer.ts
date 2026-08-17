import { join } from 'node:path';

import * as nunjucks from 'nunjucks';

import { getInitrdConfig, getZoneId } from '../../initrd/initrd.config';
import { traceRelayEnabled } from '../../telemetry/trace-relay-gate';

export const AGENT_YAML_TEMPLATE_NAME = 'agent.yaml.njk';

export interface RenderAgentYamlParams {
  deviceId: string;
  bridges: ReadonlyArray<string>;
  agentToken: string;
  jobId: string;
}

export async function renderAgentYaml(params: RenderAgentYamlParams): Promise<string> {
  const config = getInitrdConfig();

  const templateDir = join(config.assetsDir, 'initrd', 'brokkr-discovery', 'brokkr', 'opt', 'brokkr');

  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(templateDir), {
    autoescape: false,
    throwOnUndefined: true,
    trimBlocks: false,
    lstripBlocks: false,
  });

  const rendered = env.render(AGENT_YAML_TEMPLATE_NAME, {
    device_id: params.deviceId,
    zone_id: getZoneId(),
    bridges: params.bridges,
    agent_token: params.agentToken,
    log_level: config.logLevel,
    insecure: config.grpcInsecure || config.localSimulationEnabled,
    telemetry_traces_enabled: traceRelayEnabled(),
    grpc_dialback_host: config.grpcDialbackHost !== '' ? config.grpcDialbackHost : undefined,
  });

  return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}
