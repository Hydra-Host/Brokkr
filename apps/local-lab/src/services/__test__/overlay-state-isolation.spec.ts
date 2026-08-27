import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SELF = 'overlay-state-isolation.spec.ts';
const specDir = join(process.cwd(), 'src', 'services', '__test__');

const appliesForReal = (src: string): boolean =>
  src.includes('new RenderedConfigService(') && /applyOverlay\(|reloadGroup\(/.test(src);

describe('overlay-config state isolation', () => {
  it('every spec that applies an overlay for real takes its DEVENV_STATE from the scratch helper', () => {
    const unguarded = readdirSync(specDir)
      .filter((name) => name.endsWith('.spec.ts') && name !== SELF)
      .filter((name) => {
        const src = readFileSync(join(specDir, name), 'utf8');
        return appliesForReal(src) && !src.includes("from './isolated-state'");
      });

    expect(unguarded).toEqual([]);
  });
});
