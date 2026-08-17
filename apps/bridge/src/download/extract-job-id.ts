import type { FastifyRequest } from 'fastify';

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
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function contentTypeOf(req: FastifyRequest): string {
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

function decodePlusForm(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
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

export function extractJobIdFromRequest(req: FastifyRequest): string {
  const headerValue = firstHeaderValue(req.headers['x-brokkr-job-id']);
  if (typeof headerValue === 'string' && headerValue !== '') return headerValue;

  const query = req.query;
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
  } else {
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const fromForm = readJobIdField(body);
      if (fromForm !== null) return fromForm;
    }

    if (typeof body === 'string') {
      const fromRaw = parseRawBodyForJobId(body);
      if (fromRaw !== null) return fromRaw;
    } else if (Buffer.isBuffer(body)) {
      const fromRaw = parseRawBodyForJobId(body.toString('utf8'));
      if (fromRaw !== null) return fromRaw;
    }
  }

  return '';
}
