import { Injectable, type NestMiddleware } from '@nestjs/common';

import { logDebug } from '../../logger/logger.service';
import { getErrorMessage } from '../error-utils';
import { JobIdService } from '../job-id.service';

export interface JobIdRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly query?: unknown;
  readonly body?: unknown;
}

type NextFn = (err?: unknown) => void;

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function firstQueryValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function readJobIdField(obj: unknown): string | null {
  if (obj !== null && typeof obj === 'object') {
    const value: unknown = Reflect.get(obj as object, 'job_id');
    if (typeof value === 'string') {
      return value === '' ? null : value;
    }
    if (typeof value === 'number' && value !== 0) {
      return String(value);
    }
    if (typeof value === 'bigint' && value !== 0n) {
      return String(value);
    }
    if (value === true) return 'true';
  }
  return null;
}

function contentTypeOf(req: JobIdRequest): string {
  const raw = firstHeaderValue(req.headers['content-type']);
  return raw === null ? '' : raw;
}

function isJsonContentType(contentType: string): boolean {
  const semi = contentType.indexOf(';');
  const mimetype = (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
  if (mimetype === 'application/json') return true;
  if (mimetype.endsWith('+json')) return true;
  return false;
}

const HEX = /^[0-9A-Fa-f]{2}$/;

function decodePlusForm(value: string): string {
  const withSpaces = value.replace(/\+/g, ' ');
  if (!withSpaces.includes('%')) return withSpaces;
  const parts = withSpaces.split('%');
  let out = parts[0] ?? '';
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i] ?? '';
    const head = seg.slice(0, 2);
    if (HEX.test(head)) {
      const bytes: number[] = [parseInt(head, 16)];
      let tail = seg.slice(2);
      while (i + 1 < parts.length) {
        const next = parts[i + 1] ?? '';
        const nextHead = next.slice(0, 2);
        if (tail.length === 0 && HEX.test(nextHead)) {
          bytes.push(parseInt(nextHead, 16));
          tail = next.slice(2);
          i++;
        } else {
          break;
        }
      }
      out += decoder.decode(Uint8Array.from(bytes)) + tail;
    } else {
      out += '%' + seg;
    }
  }
  return out;
}

function parseRawBodyForJobId(raw: string): string | null {
  if (!raw.includes('job_id=')) return null;
  for (const part of raw.split('&')) {
    if (part.startsWith('job_id=')) {
      const decoded = decodePlusForm(part.slice('job_id='.length));
      if (decoded !== '') return decoded;
    }
  }
  return null;
}

function decodeUtf8Ignore(buf: Buffer): string {
  const len = buf.length;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (error) {
    void logDebug(`Strict UTF-8 body decode failed, salvaging: ${getErrorMessage(error)}`);
  }
  const valid: number[] = [];
  let i = 0;
  while (i < len) {
    const b0 = buf[i] as number;
    let seqLen = 0;
    if (b0 < 0x80) {
      seqLen = 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      seqLen = 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      seqLen = 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      seqLen = 4;
    } else {
      i++;
      continue;
    }
    if (i + seqLen > len) {
      i++;
      continue;
    }
    let ok = true;
    for (let k = 1; k < seqLen; k++) {
      const bk = buf[i + k] as number;
      if ((bk & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      i++;
      continue;
    }
    if (seqLen === 2 && b0 < 0xc2) {
      i++;
      continue;
    }
    if (seqLen === 3) {
      const b1 = buf[i + 1] as number;
      if (b0 === 0xe0 && b1 < 0xa0) {
        i++;
        continue;
      }
      if (b0 === 0xed && b1 >= 0xa0) {
        i++;
        continue;
      }
    }
    if (seqLen === 4) {
      const b1 = buf[i + 1] as number;
      if (b0 === 0xf0 && b1 < 0x90) {
        i++;
        continue;
      }
      if (b0 === 0xf4 && b1 >= 0x90) {
        i++;
        continue;
      }
      if (b0 > 0xf4) {
        i++;
        continue;
      }
    }
    for (let k = 0; k < seqLen; k++) {
      valid.push(buf[i + k] as number);
    }
    i += seqLen;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(valid));
}

export function extractJobIdFromRequest(req: JobIdRequest): string {
  const headerValue = firstHeaderValue(req.headers['x-brokkr-job-id']);
  if (typeof headerValue === 'string' && headerValue !== '') return headerValue;

  const query: unknown = req.query;
  if (query !== null && typeof query === 'object') {
    const value: unknown = Reflect.get(query as object, 'job_id');
    const queryValue = firstQueryValue(value);
    if (queryValue !== null && queryValue !== '') return queryValue;
  }

  const contentType = contentTypeOf(req);
  const body: unknown = req.body;

  if (isJsonContentType(contentType)) {
    const fromJson = readJobIdField(body);
    if (fromJson !== null) return fromJson;
    return '';
  }

  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const fromForm = readJobIdField(body);
    if (fromForm !== null) return fromForm;
  }

  if (typeof body === 'string') {
    const fromRaw = parseRawBodyForJobId(body);
    if (fromRaw !== null) return fromRaw;
  } else if (Buffer.isBuffer(body)) {
    const fromRaw = parseRawBodyForJobId(decodeUtf8Ignore(body));
    if (fromRaw !== null) return fromRaw;
  }

  return '';
}

@Injectable()
export class JobIdMiddleware implements NestMiddleware {
  constructor(private readonly jobIdService: JobIdService) {}

  use(req: JobIdRequest, _res: unknown, next: NextFn): void {
    const jobId = extractJobIdFromRequest(req);
    this.jobIdService.run(jobId, () => next());
  }
}
