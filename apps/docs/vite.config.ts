import mdx from '@mdx-js/rollup';
import { REACT_SINGLETON_DEDUPE } from '@repo/vite-config/dedupe';
import { devAllowedHosts, devBindHost, devStrictPort } from '@repo/vite-config/dev-server';
import tailwindcss from '@tailwindcss/vite';
import tanstackRouter from '@tanstack/router-plugin/vite';
import { D2 } from '@terrastruct/d2';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import { fromHtml } from 'hast-util-from-html';
import path from 'path';
import rehypePrettyCode from 'rehype-pretty-code';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { defineConfig, type Plugin } from 'vite';

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

// Renders ```d2 fences to inline SVG at compile time (@terrastruct/d2 WASM, no system binary).
function rehypeD2() {
  return async (tree: HastNode) => {
    const targets: { parent: HastNode; index: number; source: string }[] = [];
    const walk = (node: HastNode) => {
      node.children?.forEach((child, index) => {
        const code = child.tagName === 'pre' ? child.children?.[0] : undefined;
        const classes = code?.properties?.className;
        if (code?.tagName === 'code' && Array.isArray(classes) && classes.includes('language-d2')) {
          targets.push({ parent: node, index, source: hastText(code) });
          return;
        }
        walk(child);
      });
    };
    walk(tree);
    if (targets.length === 0) return;

    const d2 = new D2();
    try {
      for (const target of targets) {
        const compiled = await d2.compile({
          fs: { index: target.source },
          options: { layout: 'elk', themeID: 200, pad: 16 },
        });
        const svg = await d2.render(compiled.diagram, compiled.renderOptions);
        const fragment = fromHtml(svg, { fragment: true, space: 'svg' });
        target.parent.children![target.index] = {
          type: 'element',
          tagName: 'figure',
          properties: { className: ['d2-diagram'] },
          children: fragment.children,
        };
      }
    } finally {
      // Free the WASM worker so vite build can exit.
      const worker: unknown = Reflect.get(d2, 'worker');
      if (worker && typeof Reflect.get(Object(worker), 'terminate') === 'function') {
        void Reflect.get(Object(worker), 'terminate').call(worker);
      }
    }
  };
}

// Serves the docs search corpus (content-relative path -> lowercased MDX source)
// as a lazy virtual module; the MDX plugin owns real .mdx imports, so ?raw is unusable.
function docsSearchIndexPlugin(): Plugin {
  const VIRTUAL_ID = 'virtual:docs-search-index';
  const RESOLVED_ID = `\0${VIRTUAL_ID}`;
  const contentRoot = path.resolve(__dirname, 'content');
  return {
    name: 'docs-search-index',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
    },
    load(id) {
      if (id !== RESOLVED_ID) return;
      const texts: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name.endsWith('.mdx')) {
            this.addWatchFile(full);
            texts[path.relative(contentRoot, full).split(path.sep).join('/')] = fs
              .readFileSync(full, 'utf8')
              .toLowerCase();
          }
        }
      };
      walk(contentRoot);
      return `export default ${JSON.stringify(texts)};`;
    },
  };
}

// Serve the generated Redoc page (public/api/index.html) at /api in dev; Vite's static
// layer does not resolve that dir-index the way sirv does in the built image.
function serveApiReferenceDev(): Plugin {
  const file = path.resolve(__dirname, 'public/api/index.html');
  return {
    name: 'serve-api-reference-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if ((url === '/api' || url === '/api/') && fs.existsSync(file)) {
          res.setHeader('Content-Type', 'text/html');
          res.end(fs.readFileSync(file));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      // MDX docs compile to components; `pre` so output exists before the React plugin runs.
      // The `frontmatter` export feeds src/lib/docs-manifest.ts.
      {
        enforce: 'pre' as const,
        ...mdx({
          providerImportSource: '@mdx-js/react',
          remarkPlugins: [remarkFrontmatter, [remarkMdxFrontmatter, { name: 'frontmatter' }], remarkGfm],
          // Shiki highlighting at compile time; keepBackground off so the docs
          // page owns the code-block surface color.
          rehypePlugins: [
            rehypeD2,
            [rehypePrettyCode, { theme: 'github-dark-default', keepBackground: false, defaultLang: 'text' }],
          ],
        }),
      },
      docsSearchIndexPlugin(),
      serveApiReferenceDev(),
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '~': path.resolve(__dirname, './src'),
      },
      dedupe: REACT_SINGLETON_DEDUPE,
    },
    server: {
      host: devBindHost(),
      allowedHosts: devAllowedHosts(),
      // No proxy here, but the host check and CORS are stated rather than inherited, like the sibling dev servers.
      cors: false,
      port: Number(process.env.PORT || 5200),
      strictPort: devStrictPort(),
    },
  };
});
