import { access, chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { getErrorMessage } from '../common/error-utils';

import nunjucks from 'nunjucks';

import { missingBridgeHostnames, type BridgeRegistrySnapshot } from '../bridge-network/bridge-registry-reader.js';
import { extractStaticAddresses } from '../bridge-network/netplan-extract-addresses.js';
import { NIL_DEVICE_ID } from '../common/redis/redis-keys.js';
import { getLeaderConfig } from '../leader-election/leader-election.config.js';
import { traceRelayEnabled } from '../telemetry/trace-relay-gate.js';
import { CommonInitrdUtils, InitrdBuildError } from './common-utils.js';
import { getInitrdConfig, getZoneId } from './initrd.config.js';
import { createSshKeyService } from './ssh-key.service.js';

import { getLogger } from '../logger/logger.service';

const logDebug = (msg: string, ctx?: unknown): void => void getLogger().debug(msg, ctx);
const logInfo = (msg: string, ctx?: unknown): void => void getLogger().info(msg, ctx);
const logWarning = (msg: string, ctx?: unknown): void => void getLogger().warning(msg, ctx);
const logError = (msg: string, ctx?: unknown): void => void getLogger().error(msg, ctx);

export interface BridgeIpResolver {
  getBridgeIpForDevice(netplanYaml: string): Promise<string>;
  getBridgeIpForHostsFile(): Promise<string>;
  resolveBridgeIpForDevice(netplanYaml: string | null): Promise<{ ip: string; authoritative: boolean }>;
}

export interface AgentTokenMinter {
  mintOrReuseDevice(deviceId: string, jobId?: string): Promise<string>;
  mintOrReuseDiscovery(discoveryId: string, jobId?: string): Promise<string>;
}

export interface BrokkrDiscoveryInitrdDeps {
  fetchLiveNetplanForInitrd(deviceId: string, jobId: string): Promise<string | null>;
  createBridgeIpResolutionService(jobId: string): Promise<BridgeIpResolver>;
  getBridgeHostsEntriesForClient(
    clientIp: string,
    jobId: string,
    fallbackAddr?: string | null,
  ): Promise<ReadonlyArray<readonly [string, string]>>;
  getAllBridgeHostnames(jobId: string): Promise<string[]>;
  getBridgeRegistrySnapshot(jobId: string): Promise<BridgeRegistrySnapshot>;
  agentTokens: AgentTokenMinter;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export const TEMPLATE_SUFFIX = '.njk';

const REQUIRED_DISCOVERY_TEMPLATES = new Set([
  'brokkr/opt/brokkr/agent.yaml.njk',
  'brokkr/opt/brokkr/lockscreen.env.njk',
]);

export async function findTemplateFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(TEMPLATE_SUFFIX)) {
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files.sort();
}

export function createTemplateEnvironment(): nunjucks.Environment {
  return new nunjucks.Environment(null, { autoescape: false, trimBlocks: false, lstripBlocks: false });
}

export function renderTemplateKeepTrailingNewline(
  env: nunjucks.Environment,
  source: string,
  vars: Record<string, unknown>,
): string {
  const rendered = env.renderString(source, vars);
  if (source.endsWith('\n') && !rendered.endsWith('\n')) {
    return rendered + '\n';
  }
  return rendered;
}

export class BrokkrDiscoveryInitrdService {
  readonly jobId: string;
  private readonly utils: CommonInitrdUtils;
  private readonly deps: BrokkrDiscoveryInitrdDeps;

  constructor(jobId: string, deps: BrokkrDiscoveryInitrdDeps, utils?: CommonInitrdUtils) {
    this.jobId = jobId;
    this.deps = deps;
    this.utils = utils ?? new CommonInitrdUtils(jobId);
  }

  async buildBrokkrDiscoveryInitrd(
    jobId: string,
    deviceId: string,
    deviceData: Record<string, unknown> | null = null,
    outputName: string | null = null,
    clientIp = '',
  ): Promise<void> {
    try {
      const cfg = getInitrdConfig();
      const initrdBuildsDir = cfg.initrdBuildsDir;
      const outputFile = join(initrdBuildsDir, outputName ?? `brokkr-discovery-${deviceId}.img`);

      logInfo(`Building comprehensive brokkr-discovery initrd for device ${deviceId} with job ID ${jobId}`, {
        jobId: this.jobId,
      });

      await mkdir(initrdBuildsDir, { recursive: true });

      const tempPath = await mkdtemp(join(tmpdir(), 'brokkr-discovery-'));
      try {
        const initrdDir = join(tempPath, 'inventory_initrd');
        await mkdir(initrdDir, { recursive: true });

        logDebug(`Building brokkr-discovery initrd in temporary directory: ${initrdDir}`, { jobId: this.jobId });

        logDebug(`Step 1: Copying device assets to initrd directory ${initrdDir}`, { jobId: this.jobId });
        await this.copyDeviceAssetsToInitrd(initrdDir);

        logDebug(`Step 2: Collecting template variables for device ${deviceId}`, { jobId: this.jobId });
        const templateVars = await this.collectTemplateVariables(deviceData, deviceId, jobId, clientIp);

        logDebug(`Step 3: Rendering all template files in ${initrdDir}`, { jobId: this.jobId });
        await this.renderAllTemplates(initrdDir, templateVars);

        logDebug(`Step 4: Building brokkr-discovery initrd image from ${initrdDir} to ${outputFile}`, {
          jobId: this.jobId,
        });
        await this.utils.executeInitrdBuild(initrdDir, outputFile, 'brokkr-discovery');

        const fileStat = await stat(outputFile);

        logInfo(
          `Successfully built brokkr-discovery initrd for device ${deviceId}: ${outputFile} (${fileStat.size} bytes)`,
          {
            jobId: this.jobId,
          },
        );
      } finally {
        await rm(tempPath, { recursive: true, force: true });
      }
    } catch (e) {
      logError(`Failed to build brokkr-discovery initrd for device ${deviceId}: ${getErrorMessage(e)}`, {
        jobId: this.jobId,
      });
      throw new InitrdBuildError(
        `Could not build brokkr-discovery initrd for device ${deviceId}: ${getErrorMessage(e)}`,
      );
    }
  }

  private async copyDeviceAssetsToInitrd(initrdDir: string): Promise<void> {
    try {
      const deviceAssetsDir = join(getInitrdConfig().assetsDir, 'initrd', 'brokkr-discovery');

      if (await pathExists(deviceAssetsDir)) {
        logDebug(`Copying device assets from ${deviceAssetsDir} to ${initrdDir}`, { jobId: this.jobId });

        await cp(deviceAssetsDir, initrdDir, {
          recursive: true,
          force: true,
          dereference: true,
          filter: async (src) => {
            try {
              const ls = await lstat(src);
              if (ls.isSymbolicLink()) {
                try {
                  await stat(src);
                } catch {
                  return false;
                }
              }
            } catch (error) {
              logDebug(`Initrd asset filter lstat failed for ${src}: ${getErrorMessage(error)}`, { jobId: this.jobId });
            }
            return true;
          },
        });

        logInfo('Device assets copied to initrd successfully', { jobId: this.jobId });
      } else {
        logWarning(`Device assets directory not found: ${deviceAssetsDir}`, { jobId: this.jobId });
      }
    } catch (e) {
      logError(`Failed to copy device assets: ${getErrorMessage(e)}`, { jobId: this.jobId });
      throw e;
    }
  }

  private async collectTemplateVariables(
    deviceData: Record<string, unknown> | null,
    deviceId: string,
    jobId: string,
    clientIp: string,
  ): Promise<Record<string, unknown>> {
    const templateVars = await this.utils.getTemplateVariables(String(deviceId));
    templateVars['device_id'] = deviceId;
    templateVars['zone_id'] = getZoneId();

    const netplan = await this.deps.fetchLiveNetplanForInitrd(deviceId, this.jobId);

    let bridgeIp = '';
    let bridgeIpAuthoritative = false;
    try {
      const bridgeIpService = await this.deps.createBridgeIpResolutionService(this.jobId);
      const resolved = await bridgeIpService.resolveBridgeIpForDevice(netplan || null);
      bridgeIp = resolved.ip;
      bridgeIpAuthoritative = resolved.authoritative;

      if (bridgeIp) {
        logInfo(`Found bridge network IP: ${bridgeIp}`, { jobId: this.jobId });
      } else {
        logWarning('No bridge network IP found, using localhost', { jobId: this.jobId });
        bridgeIp = '127.0.0.1';
        bridgeIpAuthoritative = false;
      }
    } catch (e) {
      logError(`Failed to get bridge network IP: ${getErrorMessage(e)}`, { jobId: this.jobId });
      bridgeIp = '127.0.0.1';
    }

    templateVars['bridge_ip'] = bridgeIp;
    templateVars['bridge_hostname'] = getLeaderConfig().instanceId;

    templateVars['bridge_hosts'] = [];
    try {
      const addresses = extractStaticAddresses(netplan);
      // Peers on the same subnet as our own IP for this device are reachable the same way it is; a guessed IP is not.
      const peerFallbackAddr = bridgeIpAuthoritative ? bridgeIp : null;
      let populated = false;
      let presentHostnames: string[] = [];
      for (const { ip } of addresses) {
        const entries = await this.deps.getBridgeHostsEntriesForClient(ip, this.jobId, peerFallbackAddr);
        if (entries.length === 0) continue;
        templateVars['bridge_hosts'] = entries.map(([bridgeIp, hostname]) => ({ ip: bridgeIp, hostname }));
        presentHostnames = entries.map(([, hostname]) => hostname);
        logInfo(`Populated ${entries.length} bridge_hosts entries for device ${deviceId} from address=${ip}`, {
          jobId: this.jobId,
        });
        populated = true;
        break;
      }
      if (!populated && clientIp) {
        const entries = await this.deps.getBridgeHostsEntriesForClient(clientIp, this.jobId, peerFallbackAddr);
        if (entries.length > 0) {
          templateVars['bridge_hosts'] = entries.map(([bridgeIp, hostname]) => ({ ip: bridgeIp, hostname }));
          presentHostnames = entries.map(([, hostname]) => hostname);
          logInfo(`Populated ${entries.length} bridge_hosts entries for device ${deviceId} from address=${clientIp}`, {
            jobId: this.jobId,
          });
          populated = true;
        }
      }
      if (!populated) {
        logWarning(`No bridge hosts found for device ${deviceId}; bridge_hosts will be empty`, {
          jobId: this.jobId,
        });
      } else {
        const snapshot = await this.deps.getBridgeRegistrySnapshot(this.jobId);
        const missing = missingBridgeHostnames(snapshot, presentHostnames);
        if (missing.length > 0) {
          logWarning(
            `Partial bridge_hosts for device ${deviceId}: no reachable address for bridges=[${missing.join(', ')}]`,
            { jobId: this.jobId },
          );
        }
      }
    } catch (exc) {
      logWarning(`Failed to populate bridge_hosts for device ${deviceId}: ${getErrorMessage(exc)}`, {
        jobId: this.jobId,
      });
    }

    if (netplan) {
      logInfo(`Found netplan configuration for device ${deviceId}`, { jobId: this.jobId });
      templateVars['netplan'] = netplan;
    } else {
      logWarning(`No netplan configuration found for device ${deviceId}`, { jobId: this.jobId });
      templateVars['netplan'] = '';
    }

    const cfg = getInitrdConfig();
    templateVars['job_id'] = jobId;
    templateVars['bridge_url'] = cfg.bridgeUrl;
    templateVars['log_level'] = cfg.logLevel;

    try {
      const hostnames = await this.deps.getAllBridgeHostnames(this.jobId);
      const port = cfg.grpcExternalPort;
      templateVars['bridges'] = hostnames.map((h) => `${h}:${port}`);
    } catch (exc) {
      logWarning(`Failed to populate bridges from registry for device ${deviceId}: ${getErrorMessage(exc)}`, {
        jobId: this.jobId,
      });
      templateVars['bridges'] = [];
    }

    // Plaintext h2c when there's no TLS front (GRPC_INSECURE) or in local sim; the agent derives the scheme from this.
    templateVars['insecure'] = cfg.grpcInsecure || cfg.localSimulationEnabled;

    templateVars['grpc_dialback_host'] = cfg.grpcDialbackHost !== '' ? cfg.grpcDialbackHost : undefined;

    templateVars['telemetry_traces_enabled'] = traceRelayEnabled();

    if (deviceId === NIL_DEVICE_ID) {
      const rawMac = deviceData && 'mac' in deviceData ? deviceData['mac'] : '';
      if (typeof rawMac !== 'string') {
        throw new TypeError(
          `device_data['mac'] is not a string (got ${typeof rawMac}); cannot mint discovery token for device_id=${deviceId}`,
        );
      }
      const discoveryId = rawMac.toLowerCase() || NIL_DEVICE_ID;
      templateVars['agent_token'] = await this.deps.agentTokens.mintOrReuseDiscovery(discoveryId, this.jobId);
    } else {
      templateVars['agent_token'] = await this.deps.agentTokens.mintOrReuseDevice(String(deviceId), this.jobId);
    }

    const sshKeyService = await createSshKeyService(this.jobId);
    const pubkeys = await sshKeyService.getBridgeSshKeys((s) => this.utils.parseSshKeys(s));

    templateVars['pubkeys'] = pubkeys;

    return templateVars;
  }

  private async renderAllTemplates(initrdDir: string, templateVars: Record<string, unknown>): Promise<void> {
    const templateFiles = await findTemplateFiles(initrdDir);
    if (templateFiles.length === 0) {
      logDebug('No template files found to render', { jobId: this.jobId });
      return;
    }

    logInfo(`Rendering ${templateFiles.length} template files`, { jobId: this.jobId });

    let renderedCount = 0;
    for (const templateFile of templateFiles) {
      const templatePath = relative(initrdDir, templateFile);
      try {
        const env = createTemplateEnvironment();
        const source = await readFile(templateFile, 'utf-8');
        const renderedContent = renderTemplateKeepTrailingNewline(env, source, templateVars);

        const outputFile = templateFile.slice(0, -TEMPLATE_SUFFIX.length);
        await this.utils.saveFile(outputFile, renderedContent, '0644');

        const outputName = basename(outputFile);
        if (outputName.endsWith('.key') || outputName === 'jwt.token' || outputName === 'agent.yaml') {
          await chmod(outputFile, 0o600);
        } else if (
          extname(outputFile) === '.sh' ||
          (basename(dirname(outputFile)) === 'bin' && extname(outputFile) === '')
        ) {
          await chmod(outputFile, 0o755);
        }

        await unlink(templateFile);

        renderedCount += 1;
        logDebug(`Rendered: ${templatePath}`, { jobId: this.jobId });
      } catch (e) {
        const message = `Failed to render ${templatePath}: ${getErrorMessage(e)}`;
        if (REQUIRED_DISCOVERY_TEMPLATES.has(templatePath)) {
          logError(message, { jobId: this.jobId });
          throw new InitrdBuildError(message);
        }
        logError(message, { jobId: this.jobId });
      }
    }

    logInfo(`Successfully rendered ${renderedCount}/${templateFiles.length} templates`, { jobId: this.jobId });
  }
}

export async function createBrokkrDiscoveryInitrdService(
  jobId: string,
  deps: BrokkrDiscoveryInitrdDeps,
): Promise<BrokkrDiscoveryInitrdService> {
  return new BrokkrDiscoveryInitrdService(jobId, deps);
}
