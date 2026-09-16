import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { load as loadYaml } from 'js-yaml';
import { readFileSync } from 'node:fs';

import { getErrorMessage } from '@repo/utils';
import { parseBoundary, RenderedConfigSchema, type RenderedConfig } from '../common/pc-schemas';
import { fingerprintSecret, isSecretKey, looksLikeDsn, maskDsn } from '../common/redact';
import type { ProcessEnv } from '../contract';
import { parseEnvEntries } from './env-entries';
import { ProcessComposeClient } from './process-compose.client';
import { RenderedConfigService } from './rendered-config.service';

function maskEnvValue(key: string, value: string): string {
  if (isSecretKey(key)) return '***';
  if (looksLikeDsn(value)) return maskDsn(value);
  return value;
}

export function displayEnvValue(key: string, value: string, reveal: boolean): string {
  if (!reveal) return maskEnvValue(key, value);
  return isSecretKey(key) ? fingerprintSecret(value) : looksLikeDsn(value) ? maskDsn(value) : value;
}

@Injectable()
export class ProcessEnvService {
  private readonly log = new Logger(ProcessEnvService.name);

  constructor(
    private readonly pc: ProcessComposeClient,
    private readonly rendered: RenderedConfigService,
  ) {}

  private async pidOf(name: string): Promise<number | null> {
    try {
      const procs = await this.pc.list();
      const p = procs.find((x) => x.name === name);
      const running = (p?.status ?? '').toLowerCase() === 'running';
      return p && running && typeof p.pid === 'number' && p.pid > 0 ? p.pid : null;
    } catch {
      return null;
    }
  }

  async getProcessEnv(name: string, reveal: boolean): Promise<ProcessEnv | null> {
    // Keep the Zod parse inside the try: an unreadable or malformed config is "unavailable" → 503,
    // not a generic 500.
    let doc: RenderedConfig;
    try {
      const cfgPath = await this.rendered.renderedConfigPath();
      doc = parseBoundary(
        RenderedConfigSchema,
        loadYaml(readFileSync(cfgPath, 'utf8')),
        'rendered config (process env)',
      );
    } catch (e) {
      this.log.warn(`getProcessEnv: rendered config unavailable — ${getErrorMessage(e)}`);
      throw new ServiceUnavailableException(`rendered config unavailable: ${getErrorMessage(e)}`);
    }
    const proc = doc.processes?.[name];
    if (!proc) return null;
    const configured = parseEnvEntries(proc.environment ?? []);

    let source: 'configured' | 'live' = 'configured';
    let note: string | undefined;
    let live: Map<string, string> | null = null;
    if (process.platform !== 'linux') {
      note = 'live env (/proc) is Linux-only — showing the configured process-compose env';
    } else {
      const pid = await this.pidOf(name);
      if (!pid) {
        note = 'process not running — showing the configured process-compose env';
      } else {
        try {
          live = parseEnvEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'));
          source = 'live';
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? 'error';
          note = `live env unavailable (${code}) — showing the configured process-compose env`;
        }
      }
    }

    const effective = live ?? configured;
    const driftKeys: string[] = [];
    const vars = [...effective.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => {
        const inConfig = configured.has(key);
        if (live && inConfig && configured.get(key) !== value) driftKeys.push(key);
        return {
          key,
          value: displayEnvValue(key, value, reveal),
          secret: isSecretKey(key) || looksLikeDsn(value),
          origin: inConfig ? ('process' as const) : ('live-only' as const),
        };
      });
    return { name, source, note, vars, driftKeys: driftKeys.length ? driftKeys.sort() : undefined };
  }
}
