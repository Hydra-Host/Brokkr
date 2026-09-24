import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = readFileSync(join(packageRoot, 'theme-init.js'), 'utf8');
const appsDir = join(packageRoot, '..', '..', 'apps');

const copies = readdirSync(appsDir)
  .map((app) => join(appsDir, app, 'public', 'theme-init.js'))
  .filter((file) => existsSync(file));

describe('theme-init.js', () => {
  it('is copied to at least one app', () => {
    expect(copies.length).toBeGreaterThan(0);
  });

  it.each(copies)('%s matches the canonical copy in packages/ui', (file) => {
    expect(readFileSync(file, 'utf8')).toBe(canonical);
  });
});
