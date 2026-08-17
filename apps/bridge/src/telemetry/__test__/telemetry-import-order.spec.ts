import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('bridge telemetry import order', () => {
  const mainSource = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');

  it("main.ts imports './telemetry/init' before every other app import", () => {
    const importSpecifiers = [...mainSource.matchAll(/^import\s+(?:[^'\n]*from\s+)?'([^']+)'/gm)]
      .map((match) => match[1])
      .filter((specifier) => specifier !== undefined);
    const telemetryIndex = importSpecifiers.indexOf('./telemetry/init');
    expect(telemetryIndex).toBeGreaterThanOrEqual(0);
    for (const specifier of importSpecifiers.slice(0, telemetryIndex)) {
      expect(specifier).toBe('reflect-metadata');
    }
  });

  it('dev.ts initializes telemetry after the env latch and before the Nest imports', () => {
    const devSource = readFileSync(join(__dirname, '..', '..', 'dev.ts'), 'utf8');
    const initIndex = devSource.indexOf('initBridgeTelemetry()');
    const envLatchIndex = devSource.indexOf('loadEnvDevFile(');
    const nestImportIndex = devSource.indexOf("await import('@nestjs/core')");
    expect(initIndex).toBeGreaterThanOrEqual(0);
    expect(envLatchIndex).toBeGreaterThanOrEqual(0);
    expect(nestImportIndex).toBeGreaterThanOrEqual(0);
    expect(initIndex).toBeGreaterThan(envLatchIndex);
    expect(initIndex).toBeLessThan(nestImportIndex);
  });
});
