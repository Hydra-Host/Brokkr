import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  docsAssetFiles,
  docsAssetStaticRoots,
  MONO_FONT_CSS_URL,
  REDOC_SCRIPT_URL,
  SWAGGER_CSS_URL,
  SWAGGER_SCRIPT_URL,
} from '../docs-assets';
import { getRedocHtml, getSwaggerHtml } from '../docs-html';

const REDOC_HTML = getRedocHtml();
const SWAGGER_HTML = getSwaggerHtml();

function externalOrigins(html: string): string[] {
  return html.match(/(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? [];
}

describe('docs asset bundles', () => {
  it.each(docsAssetFiles())('resolves $url to a file on disk', ({ file }) => {
    expect(existsSync(file)).toBe(true);
  });

  it.each(docsAssetFiles())('serves $url from a mounted static root', ({ url, file }) => {
    const root = docsAssetStaticRoots().find(({ serveRoot }) => url.startsWith(`${serveRoot}/`));
    expect(root).toBeDefined();
    expect(root && join(root.rootPath, relative(root.serveRoot, url))).toBe(file);
  });
});

describe('redoc docs html', () => {
  it('references no external origin', () => {
    expect(externalOrigins(REDOC_HTML)).toEqual([]);
  });

  it('loads the redoc bundle and the mono font from the local mount', () => {
    expect(REDOC_HTML).toContain(`"${REDOC_SCRIPT_URL}"`);
    expect(REDOC_HTML).toContain(`"${MONO_FONT_CSS_URL}"`);
  });

  it('restricts images to same-origin with an img-src csp', () => {
    expect(REDOC_HTML).toContain(`content="img-src 'self' data:"`);
  });

  it('themes the response schema panel', () => {
    expect(REDOC_HTML).toContain('div[class*="response-schema"] div');
    expect(REDOC_HTML).toContain('div[class*="response-schema"] span');
  });
});

describe('swagger docs html', () => {
  it('references no external origin', () => {
    expect(externalOrigins(SWAGGER_HTML)).toEqual([]);
  });

  it('loads the swagger bundles and the mono font from the local mount', () => {
    expect(SWAGGER_HTML).toContain(`"${SWAGGER_SCRIPT_URL}"`);
    expect(SWAGGER_HTML).toContain(`"${SWAGGER_CSS_URL}"`);
    expect(SWAGGER_HTML).toContain(`"${MONO_FONT_CSS_URL}"`);
  });

  it('disables the remote validator badge', () => {
    expect(SWAGGER_HTML).toContain('validatorUrl: null');
  });

  it('restricts images to same-origin with an img-src csp', () => {
    expect(SWAGGER_HTML).toContain(`content="img-src 'self' data:"`);
  });

  it('themes the response schema panel', () => {
    expect(SWAGGER_HTML).toContain('div[class*="response-schema"] div');
    expect(SWAGGER_HTML).toContain('div[class*="response-schema"] span');
  });
});
