import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const CONFIG_DIR = join(homedir(), '.config', 'brokkr');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const ActiveEnvSchema = z.object({ activeEnv: z.string() }).partial();

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function validateEnvName(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid environment name: "${name}". Must be alphanumeric, hyphens, or underscores.`);
  }
  return name;
}

export function getActiveEnvName(): string {
  const fallback = process.env.BROKKR_DEFAULT_ENV ?? 'local';
  try {
    if (!existsSync(CONFIG_FILE)) return validateEnvName(fallback);
    const parsed = ActiveEnvSchema.parse(JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')));
    return validateEnvName(parsed.activeEnv ?? fallback);
  } catch {
    return 'local';
  }
}
