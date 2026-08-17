import type { TelemetryExporterKind } from './enablement';

export interface TelemetryStatus {
  enabled: boolean;
  reason: string;
  serviceName?: string;
  exporter?: TelemetryExporterKind;
  spansExported: number;
  exportsSucceeded: number;
  exportsFailed: number;
  lastErrorMessage?: string;
  metricsEnabled: boolean;
  metricExportsSucceeded: number;
  metricExportsFailed: number;
  lastMetricErrorMessage?: string;
  logsEnabled: boolean;
  logExportsSucceeded: number;
  logExportsFailed: number;
  lastLogErrorMessage?: string;
}

const state: TelemetryStatus = {
  enabled: false,
  reason: 'not initialized',
  spansExported: 0,
  exportsSucceeded: 0,
  exportsFailed: 0,
  metricsEnabled: false,
  metricExportsSucceeded: 0,
  metricExportsFailed: 0,
  logsEnabled: false,
  logExportsSucceeded: 0,
  logExportsFailed: 0,
};

export function markDisabled(reason: string): void {
  state.enabled = false;
  state.reason = reason;
  state.metricsEnabled = false;
  state.logsEnabled = false;
}

export function markStarted(serviceName: string, exporter: TelemetryExporterKind, reason: string): void {
  state.enabled = true;
  state.reason = reason;
  state.serviceName = serviceName;
  state.exporter = exporter;
}

export function recordExportSuccess(spanCount: number): void {
  state.exportsSucceeded += 1;
  state.spansExported += spanCount;
}

export function recordExportFailure(message: string): void {
  state.exportsFailed += 1;
  state.lastErrorMessage = message;
}

export function markMetrics(enabled: boolean): void {
  state.metricsEnabled = enabled;
}

export function recordMetricExportSuccess(): void {
  state.metricExportsSucceeded += 1;
}

export function recordMetricExportFailure(message: string): void {
  state.metricExportsFailed += 1;
  state.lastMetricErrorMessage = message;
}

export function markLogs(enabled: boolean): void {
  state.logsEnabled = enabled;
}

export function recordLogExportSuccess(): void {
  state.logExportsSucceeded += 1;
}

export function recordLogExportFailure(message: string): void {
  state.logExportsFailed += 1;
  state.lastLogErrorMessage = message;
}

export function isTelemetryEnabled(): boolean {
  return state.enabled;
}

export function isLogsEnabled(): boolean {
  return state.logsEnabled;
}

export function getTelemetryStatus(): TelemetryStatus {
  return { ...state };
}
