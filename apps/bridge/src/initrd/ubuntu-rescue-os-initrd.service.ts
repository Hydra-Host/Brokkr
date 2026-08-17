import { access, cp, mkdir, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { getErrorMessage } from '../common/error-utils';

import { rescueSshPubKeys } from '../common/redis/redis-keys.js';
import { getLogger } from '../logger/logger.service.js';

import {
  createTemplateEnvironment,
  findTemplateFiles,
  renderTemplateKeepTrailingNewline,
  TEMPLATE_SUFFIX,
} from './brokkr-discovery-initrd.service.js';
import { CommonInitrdUtils, InitrdBuildError } from './common-utils.js';
import { getInitrdConfig } from './initrd.config.js';
import type { ServerTokenAtomFetcher } from './phone-home.service.js';
import { createPhoneHomeService } from './phone-home.service.js';
import { createSshKeyService } from './ssh-key.service.js';

const logDebug = (msg: string, ctx?: unknown): void => void getLogger().debug(msg, ctx);
const logInfo = (msg: string, ctx?: unknown): void => void getLogger().info(msg, ctx);
const logWarning = (msg: string, ctx?: unknown): void => void getLogger().warning(msg, ctx);
const logError = (msg: string, ctx?: unknown): void => void getLogger().error(msg, ctx);

export interface RescueKeyCache {
  get(key: string, jobId?: string): Promise<string | null>;
}

export interface UbuntuRescueOsInitrdDeps {
  cache: RescueKeyCache;
  fetchLiveNetplanForInitrd(deviceId: string, jobId: string): Promise<string | null>;
  getServerTokenAtom: ServerTokenAtomFetcher;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const REQUIRED_RESCUE_TEMPLATES = new Set(['brokkr/usr/local/bin/phone-home.njk']);

export class UbuntuRescueOsInitrdService {
  static readonly buildCooldownSeconds = 60;

  readonly jobId: string;
  private readonly utils: CommonInitrdUtils;
  private readonly deps: UbuntuRescueOsInitrdDeps;

  constructor(jobId: string, deps: UbuntuRescueOsInitrdDeps, utils?: CommonInitrdUtils) {
    this.jobId = jobId;
    this.deps = deps;
    this.utils = utils ?? new CommonInitrdUtils(jobId);
  }

  async buildUbuntuRescueOsInitrd(jobId: string, deviceId: string): Promise<void> {
    try {
      const cfg = getInitrdConfig();
      const initrdBuildsDir = cfg.initrdBuildsDir;
      const outputFile = join(initrdBuildsDir, `ubuntu-rescue-os-${deviceId}.img`);

      if (await pathExists(outputFile)) {
        const fileStat = await stat(outputFile);
        const secondsSinceModified = (Date.now() - fileStat.mtimeMs) / 1000;

        if (secondsSinceModified < UbuntuRescueOsInitrdService.buildCooldownSeconds) {
          const secondsRemaining = UbuntuRescueOsInitrdService.buildCooldownSeconds - secondsSinceModified;
          logInfo(
            `Skipping ubuntu-rescue-os initrd build for device ${deviceId} - file modified ${secondsSinceModified.toFixed(1)}s ago ` +
              `(cooldown: ${UbuntuRescueOsInitrdService.buildCooldownSeconds}s, remaining: ${secondsRemaining.toFixed(1)}s)`,
            { jobId: this.jobId },
          );
          return;
        }
      }

      logInfo(`Building minimal ubuntu-rescue-os initrd for device ${deviceId} with job ID ${jobId}`, {
        jobId: this.jobId,
      });

      await mkdir(initrdBuildsDir, { recursive: true });

      const tempPath = await mkdtemp(join(tmpdir(), 'ubuntu-rescue-os-'));
      try {
        const initrdDir = join(tempPath, 'rescue_initrd');
        await mkdir(initrdDir, { recursive: true });

        logDebug(`Building ubuntu-rescue-os initrd in temporary directory: ${initrdDir}`, { jobId: this.jobId });

        logDebug(`Step 1: Copying rescue assets to initrd directory ${initrdDir}`, { jobId: this.jobId });
        await this.copyRescueAssetsToInitrd(initrdDir);

        logDebug(`Step 2: Rendering rescue templates (.njk files) in ${initrdDir}`, { jobId: this.jobId });
        await this.renderRescueTemplates(initrdDir, deviceId, jobId);

        logDebug(`Step 3: Building ubuntu-rescue-os initrd image from ${initrdDir} to ${outputFile}`, {
          jobId: this.jobId,
        });
        await this.utils.executeInitrdBuild(initrdDir, outputFile, 'ubuntu-rescue-os');

        const fileStat = await stat(outputFile);

        logInfo(
          `Successfully built minimal ubuntu-rescue-os initrd for device ${deviceId}: ${outputFile} (${fileStat.size} bytes)`,
          {
            jobId: this.jobId,
          },
        );
      } finally {
        await rm(tempPath, { recursive: true, force: true });
      }
    } catch (e) {
      logError(`Failed to build ubuntu-rescue-os initrd for device ${deviceId}: ${getErrorMessage(e)}`, {
        jobId: this.jobId,
      });
      throw new InitrdBuildError(
        `Could not build ubuntu-rescue-os initrd for device ${deviceId}: ${getErrorMessage(e)}`,
      );
    }
  }

  private async copyRescueAssetsToInitrd(initrdDir: string): Promise<void> {
    try {
      const rescueAssetsDir = join(getInitrdConfig().assetsDir, 'initrd', 'ubuntu-rescue-os');

      if (await pathExists(rescueAssetsDir)) {
        logDebug(`Copying rescue assets from ${rescueAssetsDir} to ${initrdDir}`, { jobId: this.jobId });

        await cp(rescueAssetsDir, initrdDir, { recursive: true, force: true, verbatimSymlinks: true });

        logInfo('Rescue assets copied to initrd successfully', { jobId: this.jobId });
      } else {
        logWarning(`Rescue assets directory not found: ${rescueAssetsDir}`, { jobId: this.jobId });
      }
    } catch (e) {
      logError(`Failed to copy rescue assets: ${getErrorMessage(e)}`, { jobId: this.jobId });
      throw e;
    }
  }

  private async renderRescueTemplates(initrdDir: string, deviceId: string, jobId: string): Promise<void> {
    try {
      const templateVars = await this.utils.getTemplateVariables(deviceId);

      templateVars['device_id'] = deviceId;

      const sshKeyService = await createSshKeyService(this.jobId);
      const pubkeys = await sshKeyService.getBridgeSshKeys((s) => this.utils.parseSshKeys(s));

      const deviceSshKeys = await this.deps.cache.get(rescueSshPubKeys(deviceId), this.jobId);

      if (deviceSshKeys) {
        const parsedKeys = this.utils.parseSshKeys(deviceSshKeys);
        pubkeys.push(...parsedKeys);
        logInfo(`Found ${parsedKeys.length} device-specific rescue SSH key(s) for device ${deviceId}`, {
          jobId: this.jobId,
        });
      } else {
        logWarning(
          `No device-specific rescue SSH keys found in Redis for device ${deviceId}; continuing with bridge admin keys only`,
          {
            jobId: this.jobId,
          },
        );
      }

      templateVars['pubkeys'] = pubkeys;

      const netplan = await this.deps.fetchLiveNetplanForInitrd(deviceId, this.jobId);
      if (netplan) {
        logInfo(`Found netplan configuration for device ${deviceId}`, { jobId: this.jobId });
        templateVars['netplan'] = netplan;
      } else {
        logWarning(`No netplan configuration found for device ${deviceId}`, { jobId: this.jobId });
        templateVars['netplan'] = '';
      }

      const phoneHomeService = await createPhoneHomeService(jobId, this.deps.getServerTokenAtom);
      const phoneHomeVars = await phoneHomeService.getPhoneHomeVariables(deviceId);
      Object.assign(templateVars, phoneHomeVars);

      const templateFiles = await findTemplateFiles(initrdDir);
      logDebug(`Found ${templateFiles.length} template files to render`, { jobId: this.jobId });

      let renderedCount = 0;
      for (const templateFile of templateFiles) {
        const templatePath = relative(initrdDir, templateFile);
        try {
          const env = createTemplateEnvironment();
          const source = await readFile(templateFile, 'utf-8');
          const renderedContent = renderTemplateKeepTrailingNewline(env, source, templateVars);

          const outputFile = templateFile.slice(0, -TEMPLATE_SUFFIX.length);

          const isScript = outputFile.includes('bin') || extname(outputFile) === '';
          const permissions = isScript ? '0755' : '0644';

          await this.utils.saveFile(outputFile, renderedContent, permissions);

          await unlink(templateFile);

          logDebug(`Rendered template: ${templateFile.split('/').pop()} -> ${outputFile.split('/').pop()}`, {
            jobId: this.jobId,
          });
          renderedCount += 1;
        } catch (e) {
          const message = `Failed to render template ${templatePath}: ${getErrorMessage(e)}`;
          if (REQUIRED_RESCUE_TEMPLATES.has(templatePath)) {
            logError(message, { jobId: this.jobId });
            throw new InitrdBuildError(message);
          }
          logWarning(message, { jobId: this.jobId });
        }
      }

      logInfo(`Successfully rendered ${renderedCount}/${templateFiles.length} templates for ubuntu-rescue-os initrd`, {
        jobId: this.jobId,
      });
    } catch (e) {
      logError(`Failed to render rescue templates: ${getErrorMessage(e)}`, { jobId: this.jobId });
      throw e;
    }
  }
}

export async function createUbuntuRescueOsInitrdService(
  jobId: string,
  deps: UbuntuRescueOsInitrdDeps,
): Promise<UbuntuRescueOsInitrdService> {
  return new UbuntuRescueOsInitrdService(jobId, deps);
}
