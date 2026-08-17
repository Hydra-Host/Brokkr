import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { docsAssetFiles, docsAssetStaticRoots, MONO_FONT_CSS_URL } from '../../common/docs-assets';
import { DocsModule } from '../docs.module';

@Module({ imports: [DocsModule] })
class SpecModule {}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create(SpecModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const addr: unknown = app.getHttpServer().address();
  if (typeof addr !== 'object' || addr === null || !('port' in addr)) throw new Error('expected an AddressInfo');
  base = `http://127.0.0.1:${String(addr.port)}`;
});

afterAll(async () => {
  await app.close();
});

async function head(url: string): Promise<{ url: string; status: number; bytes: number }> {
  const res = await fetch(`${base}${url}`);
  const bytes = Number(res.headers.get('content-length') ?? 0);
  await res.body?.cancel();
  return { url, status: res.status, bytes };
}

describe('docs asset mount', () => {
  it.each(docsAssetFiles())('serves $url', async ({ url }) => {
    const { status, bytes } = await head(url);
    expect({ status, empty: bytes === 0 }).toEqual({ status: 200, empty: false });
  });

  it('serves the font files the mono stylesheet points at', async () => {
    const css = await (await fetch(`${base}${MONO_FONT_CSS_URL}`)).text();
    const relative = [...css.matchAll(/url\((\.\/[^)]+\.woff2)\)/g)].map((m) => m[1]);
    expect(relative.length).toBeGreaterThan(0);
    const mount = MONO_FONT_CSS_URL.replace(/\/[^/]+$/, '');
    const results = await Promise.all(relative.map((ref) => head(`${mount}/${String(ref).slice(2)}`)));
    expect(results.map(({ url, status }) => ({ url, status }))).toEqual(
      results.map(({ url }) => ({ url, status: 200 })),
    );
  });

  it.each(['/api/redoc', '/api/swagger'])('serves every asset %s references', async (page) => {
    const html = await (await fetch(`${base}${page}`)).text();
    const referenced = [...html.matchAll(/(?:src|href)="(\/api\/docs-assets\/[^"]+)"/g)].map((m) => String(m[1]));
    expect(referenced.length).toBeGreaterThan(0);
    const results = await Promise.all(referenced.map(head));
    expect(results.map(({ url, status }) => ({ url, status }))).toEqual(
      referenced.map((url) => ({ url, status: 200 })),
    );
  });

  it.each(docsAssetStaticRoots().map(({ serveRoot }) => serveRoot))('serves no html page at the mount root %s', async (root) => {
    const res = await fetch(`${base}${root}/`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it.each(docsAssetStaticRoots().map(({ serveRoot }) => serveRoot))('serves no html fallback below %s', async (root) => {
    const res = await fetch(`${base}${root}/no-such-file.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it('never serves the swagger demo page', async () => {
    const res = await fetch(`${base}/api/docs-assets/swagger-ui/index.html`);
    expect(res.status).toBe(404);
  });

  it.each(docsAssetFiles())('serves $url with no petstore reference', async ({ url }) => {
    const body = await (await fetch(`${base}${url}`)).text();
    expect(body).not.toContain('petstore');
  });
});
