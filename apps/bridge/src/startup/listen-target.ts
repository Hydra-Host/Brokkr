// docker-compose maps host 8080:8080 — changing this default breaks the container-to-host port mapping.
export const DEFAULT_PORT = 8080;

export const DEFAULT_HOST = '127.0.0.1';

export function resolveListenPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+(_\d+)*$/.test(trimmed)) {
    throw new Error(`Invalid PORT environment variable: ${JSON.stringify(raw)} (must be an integer)`);
  }
  return Number.parseInt(trimmed.replace(/_/g, ''), 10);
}

export function resolveListenHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HOST;
  if (raw === undefined || raw.length === 0) return DEFAULT_HOST;
  return raw;
}
