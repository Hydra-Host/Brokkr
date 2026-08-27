import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { afterEach, vi } from 'vitest';

import { specMatchesRunning, swapDiffSet } from '../mode-drift';
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
            command: 'run-spoke',
            environment: ['PROJECT_WIDE=1', 'DHCP_MODE=PROXY'],
            dependsOn: { redis: {} },
          }),
      ),
    };

    expect(await swapDiffSet(pc, writeCfg())).toEqual([]);
  });

  it('passes over a spec pinned to the merged environment the daemon reports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-diff-pin-'));
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
        '      - PROJECT_WIDE=1',
        '      - DHCP_MODE=PROXY',
        '    depends_on:',
        '      redis:',
        '        condition: process_healthy',
        '',
      ].join('\n'),
    );
    const pc = {
      processInfo: vi.fn(
        (): Promise<PcProcessConfig> =>
          Promise.resolve({
            command: 'run-spoke',
            environment: ['PROJECT_WIDE=1', 'DHCP_MODE=PROXY'],
            dependsOn: { redis: {} },
          }),
      ),
    };

    expect(await swapDiffSet(pc, cfgPath)).toEqual([]);
  });

  it('names a process whose environment differs', async () => {
    const pc = {
      processInfo: vi.fn(
        (): Promise<PcProcessConfig> =>
          Promise.resolve({
            command: 'run-spoke',
            environment: ['PROJECT_WIDE=1', 'DHCP_MODE=OFF'],
            dependsOn: { redis: {} },
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
            command: 'run-spoke',
            environment: ['PROJECT_WIDE=1', 'DHCP_MODE=PROXY'],
            dependsOn: { postgres: {} },
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
          Promise.resolve({ command: 'run-spoke', environment: [], dependsOn: {}, description: 'live-desc' }),
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
        (): Promise<PcProcessConfig> => Promise.resolve({ command: 'DIFFERENT', environment: [], dependsOn: {} }),
      ),
    };

    expect(await swapDiffSet(pc, writeCfg(''))).toEqual(['spoke']);
  });

  it('does not warn when the extended surface matches (absent ⇔ zero-value normalized)', async () => {
    const pc = {
      processInfo: vi.fn(
        (): Promise<PcProcessConfig> =>
          Promise.resolve({
            command: 'run-spoke',
            environment: [],
            dependsOn: {},
            disabled: false,
            description: '',
            readinessProbe: null,
          }),
      ),
    };
    const warn = vi.spyOn(Logger.prototype, 'warn');

    expect(await swapDiffSet(pc, writeCfg(''))).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/extended-surface drift/));
  });
});

describe('mode-drift.swapDiffSet — global task-file hash is not per-process drift', () => {
  const RENDERED_HASH = '1111111111111111111111111111111a';
  const LIVE_HASH = '2222222222222222222222222222222b';
  const cmd = (hash: string, name: string): string =>
    `exec /nix/store/zzz-devenv-tasks/bin/devenv-tasks run --task-file /nix/store/${hash}-tasks.json --mode all devenv:processes:${name}`;

  const roster: Record<string, string> = {
    'hub-api': 'HUB_PORT',
    'hub-web': 'WEB_PORT',
    spoke: 'SPOKE_PORT',
    redis: 'REDIS_PORT',
    postgres: 'PG_PORT',
    lab: 'LAB_PORT',
    fleet: 'FLEET_PORT',
  };
  const hubProcs = ['hub-api', 'hub-web'];

  const writeCfg = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-taskfile-'));
    const cfgPath = join(dir, 'process-compose.yaml');
    const lines = ['processes:'];
    for (const [name, envKey] of Object.entries(roster)) {
      lines.push(
        `  ${name}:`,
        `    command: ${cmd(RENDERED_HASH, name)}`,
        '    environment:',
        `      - ${envKey}=${hubProcs.includes(name) ? '4000' : '1000'}`,
      );
    }
    writeFileSync(cfgPath, `${lines.join('\n')}\n`);
    return cfgPath;
  };

  const livePc = () => ({
    processInfo: vi.fn(
      (name: string): Promise<PcProcessConfig> =>
        Promise.resolve({
          command: cmd(LIVE_HASH, name),
          environment: [`${roster[name]}=1000`],
          dependsOn: {},
        }),
    ),
  });

  it('reports only the processes whose environment moved, not the whole roster', async () => {
    expect(await swapDiffSet(livePc(), writeCfg())).toEqual(hubProcs);
  });

  it('reports ∅ when the task-file hash is the only difference', async () => {
    const pc = {
      processInfo: vi.fn(
        (name: string): Promise<PcProcessConfig> =>
          Promise.resolve({
            command: cmd(LIVE_HASH, name),
            environment: [`${roster[name]}=${hubProcs.includes(name) ? '4000' : '1000'}`],
            dependsOn: {},
          }),
      ),
    };

    expect(await swapDiffSet(pc, writeCfg())).toEqual([]);
  });
});

describe('specMatchesRunning', () => {
  it('matches a running process when the pinned spec repeats the project-level block', () => {
    const info: PcProcessConfig = {
      command: 'run-spoke',
      environment: ['PROJECT_WIDE=1', 'DHCP_MODE=PROXY'],
      dependsOn: { redis: {} },
    };

    expect(
      specMatchesRunning(
        {
          command: 'run-spoke',
          environment: ['PROJECT_WIDE=1', 'PROJECT_WIDE=1', 'DHCP_MODE=PROXY'],
          dependsOn: ['redis'],
        },
        info,
      ),
    ).toBe(true);
  });

  it('still reports a changed value as drift, not as a repeat', () => {
    const info: PcProcessConfig = {
      command: 'run-spoke',
      environment: ['PROJECT_WIDE=1', 'DHCP_MODE=PROXY'],
      dependsOn: { redis: {} },
    };

    expect(
      specMatchesRunning(
        { command: 'run-spoke', environment: ['PROJECT_WIDE=1', 'DHCP_MODE=OFF'], dependsOn: ['redis'] },
        info,
      ),
    ).toBe(false);
  });
});
