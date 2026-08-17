import { Logger } from '@nestjs/common';

import { buildBaseCommand, withCsvFlag } from '../command.js';
import type { IPMIDevice } from '../device.js';
import { getIpmiMonitoringConfig } from '../ipmi.config.js';
import type { IPMIResult } from '../result.js';
import { run } from '../transport.js';
import { IPMIValidationError, validateIpmiCommand } from '../validation.js';

const logger = new Logger('adapter-ipmi-batch');

export function normalizeBatchEntry(command: unknown): string[] | null {
  if (typeof command === 'string') {
    const trimmed = command.trim();
    return trimmed === '' ? [] : trimmed.split(/\s+/);
  }
  if (Array.isArray(command)) {
    return command.map(String);
  }
  return null;
}

function typeName(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export interface BatchOptions {
  timeout?: number | null;
  maxCommands?: number;
}

export async function executeBatch(
  device: IPMIDevice,
  commands: readonly unknown[],
  opts: BatchOptions = {},
): Promise<IPMIResult[]> {
  const maxCommands = opts.maxCommands ?? 20;
  if (commands.length > maxCommands) {
    throw new IPMIValidationError(`Maximum ${maxCommands} commands per batch`);
  }

  if (commands.length === 0) return [];

  const cfg = getIpmiMonitoringConfig();
  const effectiveTimeout = opts.timeout ?? cfg.commandTimeoutSeconds;

  const results: IPMIResult[] = [];
  for (const [idx, raw] of commands.entries()) {
    const parts = normalizeBatchEntry(raw);
    if (parts === null) {
      logger.warn(`Skipping batch entry at index ${idx}: expected string or array, got ${typeName(raw)}`, device.jobId);
      continue;
    }

    let validated: string[];
    try {
      validated = validateIpmiCommand(parts);
    } catch (err) {
      if (!(err instanceof IPMIValidationError)) throw err;
      results.push({
        ok: false,
        stdout: '',
        stderr: `Validation error: ${err.message}`,
        returncode: null,
        command: [...parts],
        cipherUsed: device.cipher,
        durationMs: 0,
        timedOut: false,
      });
      continue;
    }

    const head = validated[0];
    const useCsv = head !== undefined && cfg.csvOutputCommands.includes(head);

    let base = buildBaseCommand(device);
    if (useCsv) {
      base = withCsvFlag(base);
    }

    const finalCommand = [...base, ...validated];
    const result = await run(finalCommand, device.password, effectiveTimeout, {
      cipherUsed: device.cipher,
      jobId: device.jobId,
    });
    results.push({ ...result, command: [...validated] });
  }

  return results;
}
