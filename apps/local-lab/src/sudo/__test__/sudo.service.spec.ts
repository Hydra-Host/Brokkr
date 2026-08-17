import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';

import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SudoService, sudoersDrift, sudoersDropInName } from '../sudo.service';

const { spawnMock, readdirMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), readdirMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: readdirMock };
});

const HELPER = '/nix/store/y6mcb9q49kmw23xv3jcnpaah4k43c7fa-brokkr-sim-priv/bin/brokkr-sim-priv';
const HELPER_DROPIN = 'brokkr-sim-y6mcb9q49kmw';

let written: string[];

function exitWith(code: number): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('close', code));
    return Object.assign(child, {
      stdin: {
        write: (chunk: string) => {
          written.push(chunk);
        },
        end: () => {},
      },
    });
  });
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function expectTooManyRequests(error: unknown): HttpException {
  if (!(error instanceof HttpException)) throw new Error(`expected an HttpException, got ${String(error)}`);
  expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  return error;
}

describe('SudoService.cache throttling', () => {
  let svc: SudoService;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    spawnMock.mockReset();
    written = [];
    svc = new SudoService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('still attempts sudo for the rejections before the threshold', async () => {
    exitWith(1);
    await expect(svc.cache('one')).resolves.toBe(false);
    await expect(svc.cache('two')).resolves.toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('attempts the third rejection and arms the cooldown after it', async () => {
    exitWith(1);
    await expect(svc.cache('one')).resolves.toBe(false);
    await expect(svc.cache('two')).resolves.toBe(false);
    await expect(svc.cache('three')).resolves.toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(3);

    expectTooManyRequests(await catchError(svc.cache('four')));
  });

  it('refuses a call inside the cooldown without invoking sudo', async () => {
    exitWith(1);
    await svc.cache('one');
    await svc.cache('two');
    await svc.cache('three');
    spawnMock.mockClear();

    expectTooManyRequests(await catchError(svc.cache('four')));
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports the remaining cooldown seconds in the refusal', async () => {
    exitWith(1);
    await svc.cache('one');
    await svc.cache('two');
    await svc.cache('three');

    const refused = expectTooManyRequests(await catchError(svc.cache('four')));
    expect(refused.message).toContain('30');

    vi.setSystemTime(Date.now() + 21_000);
    const later = expectTooManyRequests(await catchError(svc.cache('five')));
    expect(later.message).toContain('9');
  });

  it('resets the consecutive count when an attempt succeeds', async () => {
    exitWith(1);
    await svc.cache('one');
    await svc.cache('two');
    exitWith(0);
    await expect(svc.cache('right')).resolves.toBe(true);
    exitWith(1);
    spawnMock.mockClear();

    await expect(svc.cache('three')).resolves.toBe(false);
    await expect(svc.cache('four')).resolves.toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('attempts again once the cooldown has elapsed', async () => {
    exitWith(1);
    await svc.cache('one');
    await svc.cache('two');
    await svc.cache('three');
    spawnMock.mockClear();

    vi.setSystemTime(Date.now() + 30_000);
    await expect(svc.cache('four')).resolves.toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('spawns sudo once for a concurrent burst and refuses the rest with 429', async () => {
    exitWith(1);
    const settled = await Promise.allSettled([
      svc.cache('a'),
      svc.cache('b'),
      svc.cache('c'),
      svc.cache('d'),
      svc.cache('e'),
    ]);

    expect(spawnMock).toHaveBeenCalledTimes(1);

    const refusals: unknown[] = [];
    const attempts: unknown[] = [];
    for (const result of settled) {
      if (result.status === 'rejected') refusals.push(result.reason);
      else attempts.push(result.value);
    }
    expect(attempts).toEqual([false]);
    expect(refusals).toHaveLength(4);
    for (const refusal of refusals) {
      expect(expectTooManyRequests(refusal).message).toContain('in flight');
    }
    expect(written).toEqual(['a\n']);
  });

  it('distinguishes the in-flight refusal from the cooldown refusal', async () => {
    exitWith(1);
    const attempt = svc.cache('a');
    const inFlight = expectTooManyRequests(await catchError(svc.cache('b')));
    await expect(attempt).resolves.toBe(false);
    expect(inFlight.message).toContain('in flight');
    expect(inFlight.message).not.toContain('retry in');

    await svc.cache('two');
    await svc.cache('three');
    const cooled = expectTooManyRequests(await catchError(svc.cache('four')));
    expect(cooled.message).toContain('retry in');
    expect(cooled.message).not.toContain('in flight');
  });

  it('does not count concurrent refusals toward the rejection threshold', async () => {
    exitWith(1);
    await Promise.allSettled([svc.cache('a'), svc.cache('b'), svc.cache('c'), svc.cache('d'), svc.cache('e')]);
    spawnMock.mockClear();

    await expect(svc.cache('two')).resolves.toBe(false);
    await expect(svc.cache('three')).resolves.toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('releases the in-flight claim after a rejected attempt', async () => {
    exitWith(1);
    const first = svc.cache('one');
    const refused = catchError(svc.cache('two'));
    await expect(first).resolves.toBe(false);
    expectTooManyRequests(await refused);
    spawnMock.mockClear();

    await expect(svc.cache('three')).resolves.toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight claim after a thrown attempt', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    await expect(svc.cache('one')).rejects.toThrow('spawn failed');

    exitWith(1);
    spawnMock.mockClear();
    await expect(svc.cache('two')).resolves.toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight claim after a successful attempt', async () => {
    exitWith(0);
    await expect(svc.cache('right')).resolves.toBe(true);
    spawnMock.mockClear();

    await expect(svc.cache('right')).resolves.toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('pipes the password to stdin without retaining it on the instance', async () => {
    exitWith(1);
    await svc.cache('hunter2');

    expect(written).toEqual(['hunter2\n']);
    expect(inspect(svc, { depth: 6 })).not.toContain('hunter2');
  });
});

describe('sudoersDropInName', () => {
  it('names the drop-in after the helper store hash prefix', () => {
    expect(sudoersDropInName(HELPER)).toBe(HELPER_DROPIN);
  });

  it('gives two helper revisions two different names', () => {
    const other = '/nix/store/zzz0000000001111111111111111111z-brokkr-sim-priv/bin/brokkr-sim-priv';
    expect(sudoersDropInName(other)).not.toBe(sudoersDropInName(HELPER));
  });

  it('returns null for a helper outside the nix store', () => {
    expect(sudoersDropInName('/usr/local/bin/brokkr-sim-priv')).toBeNull();
  });
});

describe('sudoersDrift', () => {
  it('reports no drift when the installed policy authorises this helper', () => {
    expect(sudoersDrift({ helperBin: HELPER, installed: ['lima', HELPER_DROPIN] })).toBeNull();
  });

  it("reports drift when only a sibling checkout's drop-in is installed", () => {
    expect(sudoersDrift({ helperBin: HELPER, installed: ['brokkr-sim-aaaaaaaaaaaa'] })).toMatch(/other checkouts/);
  });

  it('reports drift when the legacy unsuffixed drop-in owns the host', () => {
    expect(sudoersDrift({ helperBin: HELPER, installed: ['brokkr-sim'] })).toMatch(/legacy host-wide/);
  });

  it('reports drift when the legacy drop-in is installed alongside this checkout, not instead of it', () => {
    expect(sudoersDrift({ helperBin: HELPER, installed: ['brokkr-sim', HELPER_DROPIN] })).toMatch(/legacy host-wide/);
  });

  it('reports drift when no sim drop-in is installed at all', () => {
    expect(sudoersDrift({ helperBin: HELPER, installed: ['lima'] })).toMatch(/never been installed/);
  });

  it('pins nothing when the helper path is unknown', () => {
    expect(sudoersDrift({ helperBin: null, installed: [] })).toBeNull();
  });

  it('pins nothing when the helper is not a nix store path', () => {
    expect(sudoersDrift({ helperBin: '/usr/local/bin/brokkr-sim-priv', installed: [] })).toBeNull();
  });

  it('pins nothing when sudoers.d cannot be listed', () => {
    expect(sudoersDrift({ helperBin: HELPER, installed: null })).toBeNull();
  });
});

describe('SudoService.preflight', () => {
  let svc: SudoService;

  beforeEach(() => {
    spawnMock.mockReset();
    readdirMock.mockReset();
    readdirMock.mockReturnValue([HELPER_DROPIN]);
    written = [];
    svc = new SudoService();
    vi.stubEnv('LOCAL_SIM_PRIV_BIN', HELPER);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses when sudo -n is unavailable, naming the sudo:setup terminal path', async () => {
    exitWith(1);

    const pf = await svc.preflight();

    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/sudo -n is unavailable/);
    expect(pf.reason).toMatch(/task sudo:setup/);
  });

  it('probes the helper itself, not the allowlisted /usr/bin/true', async () => {
    exitWith(0);

    await svc.preflight();

    expect(spawnMock).toHaveBeenCalledWith('sudo', ['-n', HELPER, 'noop'], expect.anything());
  });

  it('falls back to the /usr/bin/true probe when the helper path is unknown', async () => {
    exitWith(0);
    vi.stubEnv('LOCAL_SIM_PRIV_BIN', '');

    await svc.preflight();

    expect(spawnMock).toHaveBeenCalledWith('sudo', ['-n', '/usr/bin/true'], expect.anything());
  });

  it('passes when sudo -n works and the installed policy authorises this helper', async () => {
    exitWith(0);

    expect(await svc.preflight()).toEqual({ ok: true });
  });

  it("refuses when a sibling checkout's drop-in owns the host policy, even though sudo -n succeeds", async () => {
    exitWith(0);
    readdirMock.mockReturnValue(['brokkr-sim-aaaaaaaaaaaa']);

    const pf = await svc.preflight();

    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/other checkouts/);
    expect(pf.reason).toMatch(/task sudo:setup/);
  });

  it('names the legacy shadow rather than the generic probe failure when both drop-ins are installed', async () => {
    exitWith(1);
    readdirMock.mockReturnValue(['brokkr-sim', HELPER_DROPIN]);

    const pf = await svc.preflight();

    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/legacy host-wide/);
    expect(pf.reason).not.toMatch(/Cache sudo via the Sudo card/);
  });

  it('refuses when the drop-in was never installed', async () => {
    exitWith(0);
    readdirMock.mockReturnValue([]);

    expect((await svc.preflight()).reason).toMatch(/never been installed/);
  });

  it('passes when sudoers.d cannot be listed', async () => {
    exitWith(0);
    readdirMock.mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(await svc.preflight()).toEqual({ ok: true });
  });

  it('passes when there is no helper to pin against (outside the devenv shell)', async () => {
    exitWith(0);
    vi.stubEnv('LOCAL_SIM_PRIV_BIN', '');
    readdirMock.mockReturnValue([]);

    expect(await svc.preflight()).toEqual({ ok: true });
  });
});
