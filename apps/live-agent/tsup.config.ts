/// <reference types="node" />
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/exec-cli.ts'],
  outDir: 'dist',
  target: 'node24',
  format: ['cjs'],
  noExternal: [/.*/],
  clean: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  define: {
    __AGENT_VERSION__: JSON.stringify(process.env.AGENT_VERSION ?? '0.0.0-dev'),
  },
  loader: {
    '.njk': 'text',
    '.service': 'text',
    '.sh': 'text',
  },
});
