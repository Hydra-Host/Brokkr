import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { RunResult } from './exec.js';
import { CommandTimeout, run } from './exec.js';
import { getInitrdConfig } from './initrd.config.js';

import { getLogger } from '../logger/logger.service';

const logDebug = (msg: string, ctx?: unknown): void => void getLogger().debug(msg, ctx);
const logInfo = (msg: string, ctx?: unknown): void => void getLogger().info(msg, ctx);
const logWarning = (msg: string, ctx?: unknown): void => void getLogger().warning(msg, ctx);

export class InitrdBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitrdBuildError';
  }
}

export type ExecFn = (cmd: string, args: readonly string[], opts: { timeoutMs?: number }) => Promise<RunResult>;

const VALID_KEY_PREFIXES: readonly string[] = [
  'ssh-rsa',
  'ssh-dss',
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'ssh-rsa-cert-v01@openssh.com',
  'ssh-dss-cert-v01@openssh.com',
  'ssh-ed25519-cert-v01@openssh.com',
  'ecdsa-sha2-nistp256-cert-v01@openssh.com',
  'ecdsa-sha2-nistp384-cert-v01@openssh.com',
  'ecdsa-sha2-nistp521-cert-v01@openssh.com',
];

function titleCase(text: string): string {
  return text.replace(/[A-Za-z0-9_]+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function utcIsoZ(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const ms = d.getUTCMilliseconds();
  const frac = ms === 0 ? '' : `.${pad(ms, 3)}000`;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}Z`;
}

export class CommonInitrdUtils {
  readonly jobId: string;
  private readonly exec: ExecFn;

  constructor(jobId = '', exec: ExecFn = run) {
    this.jobId = jobId;
    this.exec = exec;
  }

  parseSshKeys(keysString: string): string[] {
    if (!keysString) return [];

    const lines = keysString.split('\n');
    const parsedKeys: string[] = [];

    for (const line of lines) {
      const cleaned = line.trim().replace(/\r/g, '').replace(/\t/g, ' ');

      if (!cleaned) continue;

      if (VALID_KEY_PREFIXES.some((prefix) => cleaned.startsWith(prefix))) {
        const parts = cleaned.split(/\s+/);
        const blob = parts[1];
        if (parts.length >= 2 && blob !== undefined && /^[A-Za-z0-9+/]+=*$/.test(blob)) {
          parsedKeys.push(cleaned);
        }
      }
    }

    return parsedKeys;
  }

  async getTemplateVariables(_deviceId?: string): Promise<Record<string, unknown>> {
    const cfg = getInitrdConfig();

    return {
      bridge_url: cfg.bridgeUrl,
      bridge_api_version: cfg.apiVersion,
      job_id: this.jobId,
      environment: cfg.environment,
      generated_timestamp: utcIsoZ(new Date()),
    };
  }

  async saveFile(filepath: string, content: string, mode: string): Promise<void> {
    logDebug(`Writing file: ${filepath} with mode ${mode}`, { jobId: this.jobId });
    await mkdir(dirname(filepath), { recursive: true });
    await writeFile(filepath, content);
    await chmod(filepath, parseInt(mode, 8));
    logDebug(`File written successfully: ${filepath}`, { jobId: this.jobId });
  }

  buildInitrdCommand(initrdDir: string, outputFile: string): string {
    const simFlag = getInitrdConfig().localSimulationEnabled ? ' -R 0:0' : '';
    return `cd ${initrdDir} && find . | sort | cpio --quiet -o -H newc${simFlag} > ${outputFile}`;
  }

  async executeInitrdBuild(initrdDir: string, outputFile: string, buildType = 'initrd'): Promise<void> {
    const command = this.buildInitrdCommand(initrdDir, outputFile);
    const title = titleCase(buildType);
    logDebug(`${title} initrd build command: ${command}`, { jobId: this.jobId });

    logInfo(`Building ${buildType} initrd image`, { jobId: this.jobId });

    let result: RunResult;
    try {
      result = await this.exec('/bin/sh', ['-c', command], { timeoutMs: 300_000 });
    } catch (e) {
      if (e instanceof CommandTimeout) {
        logWarning(`${title} initrd build timed out after 5 minutes, terminating process`, { jobId: this.jobId });
        throw new InitrdBuildError(`${title} initrd build timed out`);
      }
      throw e;
    }

    for (const line of result.stdout.split('\n')) {
      const logLine = line.trim();
      if (logLine) {
        logInfo(`${title} Initrd Build: ${logLine}`, { jobId: this.jobId });
      }
    }
    for (const line of result.stderr.split('\n')) {
      const logLine = line.trim();
      if (logLine) {
        logWarning(`${title} Initrd Build Warning: ${logLine}`, { jobId: this.jobId });
      }
    }

    if (result.exitCode !== 0) {
      throw new InitrdBuildError(`Failed to build ${buildType} initrd image`);
    }
  }
}
