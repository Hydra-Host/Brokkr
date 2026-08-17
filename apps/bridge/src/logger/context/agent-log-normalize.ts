import {
  AGENT_LOG_DEFAULT_EMITTER,
  AGENT_LOG_LEVEL_TO_EMITTER,
  REPORTLOGS_MAX_FIELDS_JSON_BYTES,
  REPORTLOGS_MAX_MESSAGE_BYTES,
  type AgentLogEmitter,
} from './logging-context.constants';
import { truncateUtf8ToBytes, utf8ByteLength } from './utf8-truncate';

export interface NormalizeAgentLogEntryInput {
  level: string;
  message: string;
  fieldsJson: string;
  deviceId: string;
}

export interface NormalizedAgentLogEntry {
  emitter: AgentLogEmitter;
  message: string;
  appClassName: string;
  jobId: string;
  traceId?: string;
  spanId?: string;
  fieldsJsonBytes: number;
  fieldsJsonTruncated: boolean;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

function extractHexId(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

export function normalizeAgentLogEntry(input: NormalizeAgentLogEntryInput): NormalizedAgentLogEntry {
  const { level, message, fieldsJson, deviceId } = input;

  const emitter = AGENT_LOG_LEVEL_TO_EMITTER[level.toLowerCase()] ?? AGENT_LOG_DEFAULT_EMITTER;

  const truncatedMessage = truncateUtf8ToBytes(message, REPORTLOGS_MAX_MESSAGE_BYTES);

  const fieldsJsonBytes = fieldsJson ? utf8ByteLength(fieldsJson) : 0;
  const fieldsJsonTruncated = fieldsJsonBytes > REPORTLOGS_MAX_FIELDS_JSON_BYTES;

  let fields: unknown;
  if (fieldsJsonTruncated) {
    fields = { raw_fields_truncated: `<${fieldsJsonBytes} bytes>` };
  } else if (!fieldsJson) {
    fields = {};
  } else {
    try {
      fields = JSON.parse(fieldsJson);
    } catch {
      fields = { raw_fields: fieldsJson };
    }
  }

  const fieldsRecord =
    typeof fields === 'object' && fields !== null && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : null;

  const innerClass = fieldsRecord ? fieldsRecord.app_class_name : undefined;
  const appClassName = typeof innerClass === 'string' && innerClass.length > 0 ? innerClass : 'agent';

  const jobIdRaw = fieldsRecord ? fieldsRecord.job_id : undefined;
  const jobId = fieldsRecord && Object.prototype.hasOwnProperty.call(fieldsRecord, 'job_id') ? String(jobIdRaw) : '';

  const traceId = extractHexId(fieldsRecord?.trace_id, TRACE_ID_RE);
  const spanId = extractHexId(fieldsRecord?.span_id, SPAN_ID_RE);

  return {
    emitter,
    message: `[agent device=${deviceId}] ${truncatedMessage}`,
    appClassName,
    jobId,
    ...(traceId !== undefined ? { traceId } : {}),
    ...(spanId !== undefined ? { spanId } : {}),
    fieldsJsonBytes,
    fieldsJsonTruncated,
  };
}
