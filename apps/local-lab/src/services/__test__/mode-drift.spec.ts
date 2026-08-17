import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { afterEach, vi } from 'vitest';

import { swapDiffSet } from '../mode-drift';
import type { PcProcessConfig } from '../process-compose.client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mode-drift.swapDiffSet — W3 drift detection', () => {
  const writeCfg = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-diff-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'environment:',
        '  - PROJECT_WIDE=1',
        'processes:',
        '  spoke:',
        '    command: run-spoke',
        '    environment:',
        '      - DHCP_MODE=PROXY',
        '    depends_on:',
        '      redis:',
        '        condition: process_healthy',
        '',
      ].join('\n'),
    );
    return cfgPath;
  };

  it('returns ∅ when the daemon config equals the rendered config (project env merged in)', async () => {
    const pc = {
      processInfo: vi.fn(
        (): Promise<PcProcessConfig> =>
          Promise.resolve({
            Command: 'run-spoke',
            Environment: ['PROJECT_WIDE=1', 'DHCP_MODE=PROXY'],
            DependsOn: { redis: {} },
          }),
      ),
    };

    expect(await swapDiffSet(pc, writeCfg())).toEqual([]);
  });

  it('names a process whose environment differs', async () => {
    const pc = {
      processInfo: vi.fn(
        (): Promise<PcProcessConfig> =>
          Promise.resolve({
            Command: 'run-spoke',
            Environment: ['PROJECT_WIDE=1', 'DHCP_MODE=OFF'],
            DependsOn: { redis: {} },
          }),
      ),
    };

    expect(await swapDiffSet(pc, writeCfg())).toEqual(['spoke']);
  });

  it('names a process whose depends_on key set differs', async () => {
    const pc = {
      processInfo: vi.fn(
        (): Promise<PcProcessConfig> =>
          Promise.resolve({
            Command: 'run-spoke',
            Environment: ['PROJECT_WIDE=1', 'DHCP_MODE=PROXY'],
            DependsOn: { postgres: {} },
          }),
      ),
    };

    expect(await swapDiffSet(pc, writeCfg())).toEqual(['spoke']);
  });

  it('treats a processInfo 404 / transport error as no drift (warn-and-proceed, never fail-closed)', async () => {
    const pc = {
      processInfo: vi.fn((): Promise<PcProcessConfig> => Promise.reject(new Error('HTTP 404'))),
    };

    expect(await swapDiffSet(pc, writeCfg())).toEqual([]);
  });
});

describe('mode-drift.swapDiffSet — D2.4 extended surface (warn-only)', () => {
  const writeCfg = (extra: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-ext-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    writeFileSync(
      cfgPath,
      [
        'processes:',
        '  spoke:',
        '    command: run-spoke',
        ...extra.split('\n').map((l) => (l ? `    ${l}` : l)),
        '',
      ].join('\n'),
    );
    return cfgPath;
  };

  it('does NOT include an extended-only offender in the returned (core, abort) set — logs it warn-only', async () => {
    const pc = {
      processInfo: vi.fn(
        (): Promise<PcProcessConfig> =>
          Promise.resolve({ Command: 'run-spoke', Environment: [], DependsOn: {}, Description: 'live-desc' }),
      ),
    };
    const warn = vi.spyOn(Logger.prototype, 'warn');

    const core = await swapDiffSet(pc, writeCfg('description: rendered-desc'));

    expect(core).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/extended-surface drift \(warn-only\): \{spoke\}/));
  });

  it('still returns a core offender (abort) when the command differs, regardless of the extended surface', async () => {
    const pc = {
      processInfo: vi.fn(
        (): Promise<PcProcessConfig> => Promise.resolve({ Command: 'DIFFERENT', Environment: [], DependsOn: {} }),
      ),
    };

    expect(await swapDiffSet(pc, writeCfg(''))).toEqual(['spoke']);
  });

  it('does not warn when the extended surface matches (absent ⇔ zero-value normalized)', async () => {
    const pc = {
      processInfo: vi.fn(
        (): Promise<PcProcessConfig> =>
          Promise.resolve({
            Command: 'run-spoke',
            Environment: [],
            DependsOn: {},
            Disabled: false,
            Description: '',
            ReadinessProbe: null,
          }),
      ),
    };
    const warn = vi.spyOn(Logger.prototype, 'warn');

    expect(await swapDiffSet(pc, writeCfg(''))).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/extended-surface drift/));
  });
});
