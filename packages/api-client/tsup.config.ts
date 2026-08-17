import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'contract/index': 'src/contract/index.ts',
    'contract/ipam': 'src/contract/ipam.ts',
    client: 'src/client.ts',
    'schemas/index': 'src/schemas/index.ts',
    core: 'src/core.ts',
  },
  outDir: 'dist',
  format: ['esm', 'cjs'],
  // Declarations come from `tsc` (build script), not tsup: rollup-plugin-dts widens the ts-rest contract generics to `any`, silently breaking response-body inference.
  dts: false,
  sourcemap: true,
  // Overwrite in place rather than rm -rf dist: a concurrent rebuild would blow away dist mid-flight and break consumers' `require('@repo/api-client')`.
  clean: false,
  target: 'es2022',
  // Splitting emits content-hashed shared chunks whose names change across rebuilds, making Vitest chase stale chunk files; self-contained entries keep the graph resolvable.
  splitting: false,
});
