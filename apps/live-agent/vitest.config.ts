import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

const textAssetLoader = (): Plugin => ({
  name: 'inline-text-assets',
  load(id) {
    if (/\.(njk|service|sh)$/.test(id)) {
      const content = readFileSync(id, 'utf-8');
      return `export default ${JSON.stringify(content)};`;
    }
    return null;
  },
});

export default defineConfig({
  plugins: [textAssetLoader()],
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
  },
});
