import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { contract } from '@repo/api-client';
import type { AppRoute, AppRouter } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';

const apiSrcDir = resolve(__dirname, '..');

function findControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findControllerFiles(full));
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function isAppRoute(value: unknown): value is AppRoute {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    'path' in value &&
    typeof value.path === 'string'
  );
}

const TOKEN_GUARD_RE = /@UseGuards\(\s*(?:PhoneHomeGuard|ZoneRegistrationTokenGuard)\b|@DeviceTokenAuth\(/;
const CLASS_TOKEN_GUARD_RE =
  /(?:@UseGuards\(\s*(?:PhoneHomeGuard|ZoneRegistrationTokenGuard)\b|@DeviceTokenAuth\()[^]*?export class/;

interface HandlerInfo {
  handled: Set<string>;
  publicKeys: Set<string>;
  tokenGuardedKeys: Set<string>;
}

function collectHandlerInfo(): HandlerInfo {
  const handled = new Set<string>();
  const publicKeys = new Set<string>();
  const tokenGuardedKeys = new Set<string>();

  for (const file of findControllerFiles(apiSrcDir)) {
    const src = readFileSync(file, 'utf8');
    const classIsPublic = /@Public\(\)\s*(@\w+\([^)]*\)\s*)*export class/.test(src);
    const classIsTokenGuarded = CLASS_TOKEN_GUARD_RE.test(src);

    const handlerRe = /@TsRestHandler\(\s*[A-Za-z0-9_]+\.([A-Za-z0-9_]+)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = handlerRe.exec(src)) !== null) {
      const routeKey = m[1];
      handled.add(routeKey);
      const blockStart = src.lastIndexOf('\n\n', m.index);
      const block = src.slice(blockStart === -1 ? 0 : blockStart, m.index).replace(/\/\*[\s\S]*?\*\//g, '');
      if (classIsTokenGuarded || TOKEN_GUARD_RE.test(block)) tokenGuardedKeys.add(routeKey);
      if (classIsPublic || /@Public\(\)/.test(block)) publicKeys.add(routeKey);
    }
  }
  return { handled, publicKeys, tokenGuardedKeys };
}

describe('contract auth responses', () => {
  const { handled, publicKeys, tokenGuardedKeys } = collectHandlerInfo();
  const routes = Object.entries(contract as AppRouter).filter((entry): entry is [string, AppRoute] =>
    isAppRoute(entry[1]),
  );

  it('cross-references a meaningful number of controller handlers', () => {
    expect(handled.size).toBeGreaterThan(50);
  });

  it('every route behind the global guard declares 401', () => {
    const offenders: string[] = [];
    for (const [key, route] of routes) {
      if (!handled.has(key)) continue;
      if (publicKeys.has(key) && !tokenGuardedKeys.has(key)) continue;
      const responses = route.responses as Record<number, unknown>;
      if (responses[401] === undefined) offenders.push(key);
    }
    expect(offenders, `routes missing 401: ${offenders.join(', ')}`).toEqual([]);
  });
});
