import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { bootRunLedger } from '../ledger-boot';
import { RunLedgerService } from '../run-ledger.service';
import { RunRetentionService } from '../run-retention.service';
import { StateDirLock } from '../state-dir-lock';

function stubs(reconcile: () => number = () => 0, acquired = true) {
  const order: string[] = [];
  const lock = {
    acquire: vi.fn(() => {
      order.push('acquire');
      return acquired;
    }),
  };
  const ledger = {
    reconcileOnBoot: vi.fn(() => {
      order.push('reconcile');
      return reconcile();
    }),
  };
  const retention = {
    start: vi.fn(() => {
      order.push('start');
    }),
  };
  return { order, lock, ledger, retention };
}

function boot(deps: ReturnType<typeof stubs>): void {
  bootRunLedger(
    deps.lock as unknown as StateDirLock,
    deps.ledger as unknown as RunLedgerService,
    deps.retention as unknown as RunRetentionService,
  );
}

describe('bootRunLedger', () => {
  it('reconciles behind the state-dir lock, before the first retention sweep', () => {
    const deps = stubs();

    boot(deps);

    expect(deps.order).toEqual(['acquire', 'reconcile', 'start']);
  });

  it('skips the reconcile but still starts retention when the lock is lost', () => {
    const deps = stubs(() => 0, false);

    boot(deps);

    expect(deps.ledger.reconcileOnBoot).not.toHaveBeenCalled();
    expect(deps.order).toEqual(['acquire', 'start']);
  });

  it('still starts retention when the reconcile throws, without propagating', () => {
    const deps = stubs(() => {
      throw new Error('database is locked');
    });

    expect(() => boot(deps)).not.toThrow();

    expect(deps.retention.start).toHaveBeenCalledTimes(1);
  });
});

describe('lab bootstrap ordering', () => {
  const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');

  it('boots the ledger only after the port bind has resolved', () => {
    const bind = main.indexOf('await app.listen(');
    const ledgerBoot = main.indexOf('bootRunLedger(app.get(');

    expect(bind).toBeGreaterThan(-1);
    expect(ledgerBoot).toBeGreaterThan(bind);
  });

  it('hands the boot the state-dir lock it gates the reconcile on', () => {
    expect(main).toContain('bootRunLedger(app.get(StateDirLock)');
  });

  it('leaves the reconcile out of every nest lifecycle hook', () => {
    expect(main).not.toContain('reconcileOnBoot');
    expect(readFileSync(join(process.cwd(), 'src', 'ledger', 'run-ledger.service.ts'), 'utf8')).not.toContain(
      'onModuleInit',
    );
  });
});
