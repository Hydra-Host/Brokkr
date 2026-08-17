import { isSpanContextValid, trace } from '@opentelemetry/api';

import { dispatchContext } from './dispatch/context';

export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface BufferedEntry {
  timestamp: string;
  log_level: Level;
  app_class_name: string;
  job_id: string;
  work_id: string;
  message: string;
  trace_id?: string;
  span_id?: string;
}

const LEVELS: Record<Level, number> = { trace: 5, debug: 10, info: 20, warn: 30, error: 40 };

const APP_NAME = 'bridge-agent';
const DEFAULT_APP_CLASS_NAME = 'agent';

function isLevel(value: string): value is Level {
  return value in LEVELS;
}

function readEnvLevel(): Level | null {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const raw = (process.env.AGENT_LOG_LEVEL ?? '').toLowerCase();
  return isLevel(raw) ? raw : null;
}

let threshold = LEVELS[readEnvLevel() ?? 'info'];

let sink: ((entry: BufferedEntry) => void) | null = null;

export function setLevel(level: Level) {
  threshold = LEVELS[readEnvLevel() ?? level];
}

export function setLogSink(fn: ((entry: BufferedEntry) => void) | null) {
  sink = fn;
}

function isoTimestamp(): string {
  const iso = new Date().toISOString();
  return iso.slice(0, -1) + '000+00:00';
}

function renderMessage(message: string, fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'app_class_name' || k === 'job_id') continue;
    if (v === undefined || v === null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s}`);
  }
  return parts.length > 0 ? `${message} ${parts.join(' ')}` : message;
}

function log(level: Level, message: string, fields: Record<string, unknown> = {}) {
  if (LEVELS[level] < threshold) return;
  const rawClass = fields['app_class_name'];
  const app_class_name = typeof rawClass === 'string' ? rawClass : DEFAULT_APP_CLASS_NAME;
  const rawJobId = fields['job_id'];
  let job_id = typeof rawJobId === 'string' ? rawJobId : '';
  const rawWorkId = fields['work_id'];
  let work_id = typeof rawWorkId === 'string' ? rawWorkId : '';
  if (!job_id || !work_id) {
    const ctx = dispatchContext.getStore();
    if (!job_id && ctx?.job_id) job_id = ctx.job_id;
    if (!work_id && ctx?.work_id) work_id = ctx.work_id;
  }
  const spanContext = trace.getActiveSpan()?.spanContext();
  const traceIds =
    spanContext !== undefined && isSpanContextValid(spanContext)
      ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
      : {};
  const rendered = renderMessage(message, fields);
  const record = {
    app_name: APP_NAME,
    app_class_name,
    job_id,
    work_id,
    log_level: level,
    message: rendered,
    timestamp: isoTimestamp(),
    ...traceIds,
  };
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(record) + '\n');
  if (sink) {
    try {
      sink({
        timestamp: record.timestamp,
        log_level: level,
        app_class_name,
        job_id,
        work_id,
        message: rendered,
        ...traceIds,
      });
    } catch (error) {
      void error;
    }
  }
}

export const logger = {
  trace: (msg: string, fields?: Record<string, unknown>) => log('trace', msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => log('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log('error', msg, fields),
};

export function makeLogger(app_class_name: string) {
  const merge = (fields?: Record<string, unknown>) => ({ app_class_name, ...(fields ?? {}) });
  return {
    trace: (msg: string, fields?: Record<string, unknown>) => log('trace', msg, merge(fields)),
    debug: (msg: string, fields?: Record<string, unknown>) => log('debug', msg, merge(fields)),
    info: (msg: string, fields?: Record<string, unknown>) => log('info', msg, merge(fields)),
    warn: (msg: string, fields?: Record<string, unknown>) => log('warn', msg, merge(fields)),
    error: (msg: string, fields?: Record<string, unknown>) => log('error', msg, merge(fields)),
  };
}
