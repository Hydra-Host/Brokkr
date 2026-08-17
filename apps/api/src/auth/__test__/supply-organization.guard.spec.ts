import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_SRC = join(__dirname, '..', '..');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__test__' ? [] : controllerFiles(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const CLASS_GATED =
  /@UseGuards\(\s*[^)]*\bSupplyOrganizationGuard\b[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*export\s+class\s+\w*Controller\b/;

const REFERENCES_GUARD = /\bSupplyOrganizationGuard\b/;

function domainOf(relativePath: string): string {
  return relativePath.split('/')[0];
}

interface ControllerSource {
  relative: string;
  domain: string;
  stripped: string;
}

const controllers: ControllerSource[] = controllerFiles(API_SRC).map((f) => {
  const relative = f.slice(API_SRC.length + 1);
  return { relative, domain: domainOf(relative), stripped: stripComments(readFileSync(f, 'utf8')) };
});

const supplyDomains = [
  ...new Set(controllers.filter((c) => REFERENCES_GUARD.test(c.stripped)).map((c) => c.domain)),
].sort();

describe('SupplyOrganizationGuard coverage', () => {
  it('discovers supply domains from the filesystem', () => {
    expect(controllers.length).toBeGreaterThan(0);
    expect(supplyDomains.length).toBeGreaterThan(0);
  });

  for (const domain of supplyDomains) {
    it(`every ${domain} controller is gated by SupplyOrganizationGuard`, () => {
      const ungated = controllers
        .filter((c) => c.domain === domain && !CLASS_GATED.test(c.stripped))
        .map((c) => c.relative);
      expect(ungated).toEqual([]);
    });
  }
});
