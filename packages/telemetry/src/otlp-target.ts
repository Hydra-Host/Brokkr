import { resolveEnablement } from './enablement';

export interface OtlpTracesTarget {
  url: string;
  headers: Record<string, string>;
}

/** Mirrors the OTLP exporter env contract: per-signal OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is used verbatim, the base endpoint gets /v1/traces appended. */
export function resolveOtlpTracesTarget(
  env: Record<string, string | undefined> = process.env,
): OtlpTracesTarget | undefined {
  const decision = resolveEnablement(env);
  if (!decision.enabled || decision.exporter !== 'otlp') return undefined;

  const read = (key: string): string | undefined => {
    const value = env[key]?.trim();
    return value ? value : undefined;
  };

  const perSignal = read('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
  const base = read('OTEL_EXPORTER_OTLP_ENDPOINT');
  const url = perSignal ?? (base !== undefined ? `${base.replace(/\/+$/, '')}/v1/traces` : undefined);
  if (url === undefined) return undefined;

  return {
    url,
    headers: parseHeaders(read('OTEL_EXPORTER_OTLP_TRACES_HEADERS') ?? read('OTEL_EXPORTER_OTLP_HEADERS')),
  };
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (!key) continue;
    try {
      value = decodeURIComponent(value);
    } catch (error) {
      void error;
    }
    headers[key] = value;
  }
  return headers;
}
