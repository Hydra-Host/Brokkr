import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

export interface SendFileResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  on(event: 'close', listener: () => void): unknown;
  write(chunk: Buffer | string): unknown;
  end(cb?: () => void): unknown;
}

export interface SendFileRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface SendFileOptions {
  mimetype: string;
  asAttachment?: boolean;
  attachmentFilename?: string;
  request?: SendFileRequest;
  maxAge?: number;
  conditional?: boolean;
  noStore?: boolean;
}

function adler32(input: string): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  const bytes = Buffer.from(input, 'utf-8');
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function floatStr(n: number): string {
  if (!Number.isFinite(n)) {
    if (Number.isNaN(n)) return 'nan';
    return n > 0 ? 'inf' : '-inf';
  }
  const s = String(n);
  if (s.indexOf('.') === -1 && s.indexOf('e') === -1 && s.indexOf('E') === -1) {
    return `${s}.0`;
  }
  return s;
}

function formatHttpDate(date: Date): string {
  return date.toUTCString();
}

const TOKEN_CHARS = new Set("!#$%&'*+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~");

function isToken(value: string): boolean {
  if (value.length === 0) return false;
  for (const ch of value) {
    if (!TOKEN_CHARS.has(ch)) return false;
  }
  return true;
}

function quoteHeaderValue(value: string): string {
  if (value === '') return '""';
  if (isToken(value)) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

const RFC1123_DATE_RE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const MONTH_INDEX: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

function parseIfModifiedSince(value: string | undefined): number | null {
  if (!value) return null;
  const match = RFC1123_DATE_RE.exec(value.trim());
  if (!match) return null;
  const [, dayStr, monthName, yearStr, hourStr, minuteStr, secondStr] = match;
  const month = MONTH_INDEX[monthName!];
  if (month === undefined) return null;
  const ms = Date.UTC(Number(yearStr), month, Number(dayStr), Number(hourStr), Number(minuteStr), Number(secondStr));
  return Number.isNaN(ms) ? null : ms;
}

function getHeader(req: SendFileRequest | undefined, name: string): string | undefined {
  if (!req) return undefined;
  const raw = req.headers[name.toLowerCase()] ?? req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function unquoteEtag(etag: string): string {
  let value = etag.trim();
  if (value.startsWith('W/') || value.startsWith('w/')) {
    value = value.slice(2);
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return value;
}

const ETAG_TOKEN_RE = /([Ww]\/)?(?:"(.*?)"|(.*?))(?:\s*,\s*|$)/y;

function parseEtagsContainsWeak(value: string | undefined): {
  star: boolean;
  tags: Set<string>;
} {
  const tags = new Set<string>();
  if (!value) return { star: false, tags };
  ETAG_TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < value.length) {
    ETAG_TOKEN_RE.lastIndex = pos;
    const match = ETAG_TOKEN_RE.exec(value);
    if (!match) break;
    const [, , quoted, raw] = match;
    if (raw === '*') return { star: true, tags: new Set() };
    const tag = quoted ?? raw ?? '';
    if (tag) tags.add(tag);
    if (match.index + match[0].length === pos) break;
    pos = ETAG_TOKEN_RE.lastIndex;
  }
  return { star: false, tags };
}

export async function sendFileAttachment(
  res: SendFileResponse,
  filePath: string,
  options: {
    filename: string;
    mimeType: string;
    maxAge?: number;
    request?: SendFileRequest;
    conditional?: boolean;
    noStore?: boolean;
  },
): Promise<void> {
  await sendFile(res, filePath, {
    mimetype: options.mimeType,
    asAttachment: true,
    attachmentFilename: options.filename,
    maxAge: options.maxAge,
    request: options.request,
    conditional: options.conditional,
    noStore: options.noStore,
  });
}

export async function sendFile(res: SendFileResponse, filePath: string, options: SendFileOptions): Promise<void> {
  const fileStat = await stat(filePath, { bigint: true });
  const size = Number(fileStat.size);
  const mtimeFloat = Number(fileStat.mtimeNs) / 1e9;
  const mtimeSec = Math.floor(mtimeFloat);
  const lastModified = formatHttpDate(new Date(mtimeSec * 1000));
  const etag = `"${floatStr(mtimeFloat)}-${size}-${adler32(filePath)}"`;

  let notModified = false;
  if (options.conditional) {
    const bareEtag = unquoteEtag(etag);
    const ifNoneMatchRaw = getHeader(options.request, 'if-none-match');
    const ifModifiedSinceMs = parseIfModifiedSince(getHeader(options.request, 'if-modified-since'));

    let unmodified = false;
    if (ifModifiedSinceMs !== null && mtimeSec * 1000 <= ifModifiedSinceMs) {
      unmodified = true;
    }
    if (ifNoneMatchRaw !== undefined) {
      const parsed = parseEtagsContainsWeak(ifNoneMatchRaw);
      if (parsed.star || parsed.tags.size > 0) {
        unmodified = parsed.star || parsed.tags.has(bareEtag);
      }
    }
    notModified = unmodified;
  }

  res.setHeader('Content-Type', options.mimetype);
  if (options.noStore) {
    res.setHeader('Cache-Control', 'no-store, private');
  } else {
    const maxAge = options.maxAge ?? 43200;
    res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    res.setHeader('Expires', formatHttpDate(new Date(Date.now() + maxAge * 1000)));
  }
  res.setHeader('Last-Modified', lastModified);
  res.setHeader('ETag', etag);

  if (options.asAttachment) {
    const filename = options.attachmentFilename ?? basename(filePath) ?? 'file';
    res.setHeader('Content-Disposition', `attachment; filename=${quoteHeaderValue(filename)}`);
  }

  if (notModified) {
    res.status(304);
    await new Promise<void>((resolve) => res.end(() => resolve()));
    return;
  }

  res.status(200);
  res.setHeader('Content-Length', String(size));

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => res.write(chunk));
    stream.on('end', () => {
      res.end(() => resolve());
    });
    res.on('close', () => stream.destroy());
  });
}

export interface SendFileAttachmentOptions {
  filename: string;
  mimeType: string;
  maxAge?: number;
  noStore?: boolean;
}

interface NodeServerResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: 'close', listener: () => void): unknown;
  write(chunk: Buffer | string): unknown;
  end(cb?: () => void): unknown;
}

interface FastifyReplyLike {
  raw: NodeServerResponseLike;
  request?: { headers: Record<string, string | string[] | undefined> };
}

function adaptNodeResponse(raw: NodeServerResponseLike): SendFileResponse {
  return {
    status(code: number) {
      raw.statusCode = code;
      return raw;
    },
    setHeader(name: string, value: string) {
      return raw.setHeader(name, value);
    },
    on(event: 'close', listener: () => void) {
      return raw.on(event, listener);
    },
    write(chunk: Buffer | string) {
      return raw.write(chunk);
    },
    end(cb?: () => void) {
      raw.end();
      if (cb) cb();
      return raw;
    },
  };
}

export async function sendFileAttachmentReply(
  reply: FastifyReplyLike,
  filePath: string,
  options: SendFileAttachmentOptions,
): Promise<void> {
  await sendFile(adaptNodeResponse(reply.raw), filePath, {
    mimetype: options.mimeType,
    asAttachment: true,
    attachmentFilename: options.filename,
    maxAge: options.maxAge,
    request: reply.request,
    noStore: options.noStore,
  });
}
