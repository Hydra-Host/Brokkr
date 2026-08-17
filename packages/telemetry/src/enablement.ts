export type TelemetryExporterKind = 'otlp' | 'console';

export interface EnablementDecision {
  enabled: boolean;
  reason: string;
  exporter?: TelemetryExporterKind;
}

export function resolveEnablement(env: Record<string, string | undefined>): EnablementDecision {
  const read = (key: string): string | undefined => {
    const value = env[key]?.trim();
    return value ? value : undefined;
  };

  if (read('OTEL_SDK_DISABLED')?.toLowerCase() === 'true') {
    return { enabled: false, reason: 'OTEL_SDK_DISABLED=true' };
  }

  const tracesExporter = read('OTEL_TRACES_EXPORTER');
  if (tracesExporter === 'none') {
    return { enabled: false, reason: 'OTEL_TRACES_EXPORTER=none' };
  }
  if (tracesExporter === 'console') {
    return { enabled: true, reason: 'OTEL_TRACES_EXPORTER=console', exporter: 'console' };
  }
  if (tracesExporter !== undefined && tracesExporter !== 'otlp') {
    return { enabled: false, reason: `unsupported OTEL_TRACES_EXPORTER "${tracesExporter}"` };
  }

  if (read('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') ?? read('OTEL_EXPORTER_OTLP_ENDPOINT')) {
    return { enabled: true, reason: 'OTLP endpoint configured', exporter: 'otlp' };
  }

  return {
    enabled: false,
    reason: 'no OTLP endpoint configured (set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)',
  };
}
