import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sendFile, type SendFileResponse } from '../send-file.js';

interface CapturedResponse extends SendFileResponse {
  headers: Record<string, string>;
  statusCode: number | null;
}

function makeResponse(): CapturedResponse {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    on(_event: 'close', _listener: () => void) {
      return this;
    },
    write(_chunk: Buffer | string) {
      return true;
    },
    end(cb?: () => void) {
      if (cb) cb();
      return this;
    },
  };
}

describe('sendFile Cache-Control', () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'send-file-'));
    filePath = join(root, 'artifact.img');
    writeFileSync(filePath, Buffer.from('payload'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('defaults to public, max-age=43200 with an Expires header', async () => {
    const res = makeResponse();
    await sendFile(res, filePath, { mimetype: 'application/octet-stream' });
    expect(res.headers['Cache-Control']).toBe('public, max-age=43200');
    expect(res.headers['Expires']).toBeDefined();
  });

  it('emits no-store, private and no Expires when noStore is set', async () => {
    const res = makeResponse();
    await sendFile(res, filePath, { mimetype: 'application/octet-stream', noStore: true });
    expect(res.headers['Cache-Control']).toBe('no-store, private');
    expect(res.headers['Expires']).toBeUndefined();
  });

  it('noStore overrides an explicit maxAge', async () => {
    const res = makeResponse();
    await sendFile(res, filePath, { mimetype: 'application/octet-stream', maxAge: 99, noStore: true });
    expect(res.headers['Cache-Control']).toBe('no-store, private');
  });
});
