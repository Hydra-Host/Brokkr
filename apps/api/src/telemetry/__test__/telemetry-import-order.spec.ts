import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('main.ts telemetry import order', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');

  it('initializes telemetry after dotenv and before plugins-config and @nestjs/core', () => {
    const dotenvIndex = source.search(/^import .*'dotenv\/config';?$/m);
    const telemetryIndex = source.search(/^import .*'\.\/telemetry\/init';?$/m);
    const pluginsIndex = source.search(/^import .*from '@hydrahost\/plugins-config';?$/m);
    const nestCoreIndex = source.search(/^import .*from '@nestjs\/core';?$/m);
    const appModuleIndex = source.search(/^import .*from '\.\/app\.module';?$/m);

    expect(dotenvIndex).toBeGreaterThanOrEqual(0);
    expect(telemetryIndex).toBeGreaterThanOrEqual(0);
    expect(pluginsIndex).toBeGreaterThanOrEqual(0);
    expect(nestCoreIndex).toBeGreaterThanOrEqual(0);
    expect(appModuleIndex).toBeGreaterThanOrEqual(0);

    expect(telemetryIndex).toBeGreaterThan(dotenvIndex);
    expect(telemetryIndex).toBeLessThan(pluginsIndex);
    expect(telemetryIndex).toBeLessThan(nestCoreIndex);
    expect(telemetryIndex).toBeLessThan(appModuleIndex);
  });

  it('init.ts imports only @repo/telemetry — anything else would load before instrumentation and escape tracing', () => {
    const initSource = readFileSync(join(__dirname, '..', 'init.ts'), 'utf8');
    const specifiers = [...initSource.matchAll(/^import\s+(?:[^'\n]*from\s+)?'([^']+)'/gm)]
      .map((match) => match[1])
      .filter((specifier) => specifier !== undefined);
    expect(specifiers).toEqual(['@repo/telemetry']);
  });
});
