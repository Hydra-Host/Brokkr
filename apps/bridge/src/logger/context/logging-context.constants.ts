export const NIL_JOB_ID = '00000000-0000-0000-0000-000000000000';

export const REPORTLOGS_MAX_MESSAGE_BYTES = 8 * 1024;
export const REPORTLOGS_MAX_FIELDS_JSON_BYTES = 64 * 1024;

export type AgentLogEmitter = 'log_debug' | 'log_info' | 'log_warning' | 'log_error';

export const AGENT_LOG_DEFAULT_EMITTER: AgentLogEmitter = 'log_info';

export const AGENT_LOG_LEVEL_TO_EMITTER: Record<string, AgentLogEmitter> = {
  trace: 'log_debug',
  debug: 'log_debug',
  info: 'log_info',
  warn: 'log_warning',
  warning: 'log_warning',
  error: 'log_error',
};

export const DEFAULT_LOG_SUPPRESS_JOB_ID_PREFIXES: readonly string[] = ['health-cron-', 'heartbeat-'];

export const ACCESS_LOG_QUIET_ROUTES: readonly string[] = ['/api/status', '/api/health'];

export const ACCESS_LOG_MONITORING_PREFIX = '/api/monitoring/';
