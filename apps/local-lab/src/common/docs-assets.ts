import { basename, dirname } from 'node:path';

import express, { type Express } from 'express';

const PREFIX = '/api/docs-assets';

type Bundle = { mount: string; entry: string };

const REDOC: Bundle = { mount: 'redoc', entry: 'redoc/bundles/redoc.standalone.js' };
const SWAGGER_CSS: Bundle = { mount: 'swagger-ui', entry: 'swagger-ui-dist/swagger-ui.css' };
const SWAGGER_SCRIPT: Bundle = { mount: 'swagger-ui', entry: 'swagger-ui-dist/swagger-ui-bundle.js' };
// one stylesheet carries every weight of the latin subset, so it replaces the whole google-fonts link
const MONO_FONT: Bundle = { mount: 'jetbrains-mono', entry: '@fontsource/jetbrains-mono/latin.css' };

const BUNDLES = [REDOC, SWAGGER_CSS, SWAGGER_SCRIPT, MONO_FONT];

function bundleUrl({ mount, entry }: Bundle): string {
  return `${PREFIX}/${mount}/${basename(entry)}`;
}

export const REDOC_SCRIPT_URL = bundleUrl(REDOC);
export const SWAGGER_CSS_URL = bundleUrl(SWAGGER_CSS);
export const SWAGGER_SCRIPT_URL = bundleUrl(SWAGGER_SCRIPT);
export const MONO_FONT_CSS_URL = bundleUrl(MONO_FONT);

// resolved through node's resolver rather than a relative ../../node_modules path: pnpm's symlinked
// store and git worktrees both put the real directory somewhere a fixed relative path misses.
export function docsAssetFiles(): { url: string; file: string }[] {
  return BUNDLES.map((bundle) => ({ url: bundleUrl(bundle), file: require.resolve(bundle.entry) }));
}

export function docsAssetStaticRoots(): { rootPath: string; serveRoot: string }[] {
  const roots = new Map<string, string>();
  for (const bundle of BUNDLES) {
    roots.set(`${PREFIX}/${bundle.mount}`, dirname(require.resolve(bundle.entry)));
  }
  return [...roots].map(([serveRoot, rootPath]) => ({ rootPath, serveRoot }));
}

// the docs vendor bundles are served unguarded — static middleware sits outside the guard pipeline,
// and these are public npm dists rather than lab data.
export function mountDocsAssets(app: Express): void {
  for (const { serveRoot, rootPath } of docsAssetStaticRoots()) {
    const files = express.static(rootPath, { index: false, fallthrough: true });
    app.use(serveRoot, (req, res, next) => {
      // the vendor dists ship demo html (swagger-ui-dist's index.html fetches the petstore spec) —
      // the mounts serve files only, never a page
      if (req.path.endsWith('.html')) {
        next();
        return;
      }
      files(req, res, next);
    });
  }
}
