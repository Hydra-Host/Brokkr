import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { getErrorMessage } from '../common/error-utils';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { getLogger } from '../logger/logger.service';

export const BEGIN_MARKER = '# BEGIN BROKKR OPERATOR ENV';
export const END_MARKER = '# END BROKKR OPERATOR ENV';

export class MarkerImbalanceError extends Error {
  constructor(
    public readonly beginCount: number,
    public readonly endCount: number,
  ) {
    super(`unit content has unbalanced markers: ${beginCount} BEGIN, ${endCount} END`);
    this.name = 'MarkerImbalanceError';
  }
}

// A newline/CR would split into extra unit lines and inject directives; reject rather than escape — passthrough values never legitimately contain control chars.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
// systemd parses `Environment=` as a space-separated list with shell-style quoting (systemd.syntax(7)); a space or `"'\` could inject an extra non-allowlisted variable — reject rather than escape.
const QUOTING_META = /[ "'\\]/;
// systemd assignment keys must be a C-identifier-style token.
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSafeOperatorEnvEntry(key: string, value: string): boolean {
  return SAFE_ENV_KEY.test(key) && !CONTROL_CHAR.test(value) && !QUOTING_META.test(value);
}

export function mergeOperatorEnv(unitContent: string, env: Record<string, string>): string {
  const lines = unitContent.split('\n');

  let beginCount = 0;
  let endCount = 0;
  for (const line of lines) {
    if (line.includes(BEGIN_MARKER)) beginCount += 1;
    if (line.includes(END_MARKER)) endCount += 1;
  }
  if (beginCount !== endCount) {
    throw new MarkerImbalanceError(beginCount, endCount);
  }

  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && line.includes(BEGIN_MARKER)) {
      inside = true;
      if (out.length > 0 && out[out.length - 1] === '') {
        out.pop();
      }
      continue;
    }
    if (inside && line.includes(END_MARKER)) {
      inside = false;
      continue;
    }
    if (!inside) {
      out.push(line);
    }
  }

  const deduped: string[] = [];
  for (const line of out) {
    if (line === '' && deduped.length > 0 && deduped[deduped.length - 1] === '') {
      continue;
    }
    deduped.push(line);
  }
  const working = deduped;

  while (working.length > 0 && working[working.length - 1] === '') {
    working.pop();
  }

  // Filter here too so a caller that forgot to filter can never produce a corrupted unit.
  const sortedKeys = Object.keys(env)
    .filter((k) => isSafeOperatorEnvEntry(k, env[k]))
    .sort();

  if (sortedKeys.length === 0) {
    working.push('');
    return working.join('\n');
  }

  const block = [BEGIN_MARKER, ...sortedKeys.map((k) => `Environment=${k}=${env[k]}`), END_MARKER];

  // Environment= must live under [Service]; after [Install] systemd would silently ignore it.
  let installIdx: number | null = null;
  for (let i = 0; i < working.length; i++) {
    if (working[i].trim() === '[Install]') {
      installIdx = i;
      break;
    }
  }

  const merged =
    installIdx === null
      ? [...working, '', ...block, '']
      : [...working.slice(0, installIdx), '', ...block, '', ...working.slice(installIdx)];

  return merged.join('\n');
}

export interface AgentBundleConfig {
  bundlePath: string;
  unitPath: string;
}

export function buildAgentBundleConfig(env: NodeJS.ProcessEnv = process.env): AgentBundleConfig {
  return {
    bundlePath: env.AGENT_BUNDLE_PATH ?? '/opt/brokkr/agent/main.js',
    unitPath: env.AGENT_UNIT_PATH ?? '/opt/brokkr/agent/brokkr-bridge-agent.service',
  };
}

const AGENT_SYSTEMD_ENV_PASSTHROUGH: readonly string[] = [
  'AGENT_LOG_LEVEL',
  'NODE_EXTRA_CA_CERTS',
  'LOCAL_SIMULATION_ENABLED',
];

export function getAgentSystemdEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of AGENT_SYSTEMD_ENV_PASSTHROUGH) {
    const val = env[key];
    if (val !== undefined && val !== '') {
      out[key] = val;
    }
  }
  return out;
}

export interface AgentUnitRenderStartupLogger {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

const FORWARDING_LOGGER: AgentUnitRenderStartupLogger = {
  info: (msg, ctx) => getLogger().info(msg, ctx),
  warning: (msg, ctx) => getLogger().warning(msg, ctx),
};

export const AGENT_UNIT_RENDER_STARTUP_LOGGER = Symbol('AGENT_UNIT_RENDER_STARTUP_LOGGER');

export interface AgentUnitRenderStartupFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const DEFAULT_FS: AgentUnitRenderStartupFs = {
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data, encoding) => writeFile(path, data, encoding),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  unlink: (path) => unlink(path),
};

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT'
  );
}

@Injectable()
export class AgentUnitRenderStartupService {
  private readonly logger: AgentUnitRenderStartupLogger;

  constructor(
    @Optional() @Inject(AGENT_UNIT_RENDER_STARTUP_LOGGER) logger?: AgentUnitRenderStartupLogger,
    private readonly fs: AgentUnitRenderStartupFs = DEFAULT_FS,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.logger = logger ?? FORWARDING_LOGGER;
  }

  async renderAgentUnitAtStartup(jobId: string = ''): Promise<void> {
    const cfg = buildAgentBundleConfig(this.env);
    const env = getAgentSystemdEnvironment(this.env);

    for (const key of Object.keys(env).sort()) {
      if (!isSafeOperatorEnvEntry(key, env[key])) {
        await this.logger.warning(
          `agent unit render: skipping operator env key=${key} — value contains control or quoting characters, or key is not a valid identifier`,
          { jobId },
        );
      }
    }

    const unitPath = cfg.unitPath;
    let content: string;
    try {
      content = await this.fs.readFile(unitPath, 'utf8');
    } catch (error) {
      if (isFileNotFound(error)) {
        await this.logger.warning(
          `agent unit render: file missing path=${unitPath} — skipping operator-env injection`,
          { jobId },
        );
        return;
      }
      await this.logger.warning(
        `agent unit render: read failed path=${unitPath} (${getErrorMessage(error)}) — skipping`,
        { jobId },
      );
      return;
    }

    let rendered: string;
    try {
      rendered = mergeOperatorEnv(content, env);
    } catch (error) {
      if (error instanceof MarkerImbalanceError) {
        await this.logger.warning(
          `agent unit render: refusing to rewrite due to marker imbalance (${getErrorMessage(error)}) — leaving file as-is`,
          { jobId },
        );
        return;
      }
      throw error;
    }

    if (rendered === content) {
      await this.logger.info(`agent unit render: no change (env_keys=${formatRenderedKeys(env)})`, { jobId });
      return;
    }

    const tmpPath = `${unitPath}.new`;
    try {
      await this.fs.writeFile(tmpPath, rendered, 'utf8');
      await this.fs.rename(tmpPath, unitPath);
    } catch (error) {
      await this.logger.warning(`agent unit render: write failed path=${unitPath} (${getErrorMessage(error)})`, {
        jobId,
      });
      try {
        await this.fs.unlink(tmpPath);
      } catch (cleanupError) {
        await getLogger().debug(
          `agent unit render: temp file cleanup failed path=${tmpPath} (${getErrorMessage(cleanupError)})`,
          { jobId },
        );
      }
      return;
    }

    await this.logger.info(`agent unit render: rewrote ${unitPath} with operator env keys=${formatRenderedKeys(env)}`, {
      jobId,
    });
  }
}

// Single-quoted `['A', 'B']` keeps log lines grep-stable (JSON.stringify would break the log corpus); only keys surviving filtering are listed.
function formatRenderedKeys(env: Record<string, string>): string {
  const keys = Object.keys(env)
    .filter((k) => isSafeOperatorEnvEntry(k, env[k]))
    .sort();
  return `[${keys.map((k) => `'${k}'`).join(', ')}]`;
}
