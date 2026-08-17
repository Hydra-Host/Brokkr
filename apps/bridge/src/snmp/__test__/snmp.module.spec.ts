import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('net-snmp', () => ({
  Version1: 0,
  Version2c: 1,
  Version3: 3,
  ObjectType: {},
  SecurityLevel: { noAuthNoPriv: 1, authNoPriv: 2, authPriv: 3 },
  AuthProtocols: { none: 1, md5: 2, sha: 3, sha224: 4, sha256: 5, sha384: 6, sha512: 7 },
  PrivProtocols: { none: 1, des: 2, aes: 4, aes256b: 6, aes256r: 8 },
  createSession: vi.fn(),
  createV3Session: vi.fn(),
  isVarbindError: () => false,
  varbindError: () => '',
}));

import { resetForTests as resetCronRegistry } from '../../crons/cron-registry.js';
import { resetForTests as resetSnmpEngine, SnmpEngine } from '../engine.js';
import { SnmpModule } from '../snmp.module.js';

async function buildModule(): Promise<{ module: TestingModule; engine: SnmpEngine }> {
  const module = await Test.createTestingModule({ imports: [SnmpModule] }).compile();
  return { module, engine: module.get(SnmpEngine) };
}

describe('SnmpModule lifecycle wiring', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCronRegistry();
    resetSnmpEngine();
  });

  it('starts the engine on application bootstrap so /api/health reports ok', async () => {
    process.env.SNMP_ENABLED = 'true';
    const { module, engine } = await buildModule();
    const startSpy = vi.spyOn(engine, 'start');

    await module.init();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(engine.isStarted()).toBe(true);
    expect(engine.isClosed()).toBe(false);

    await module.close();
    delete process.env.SNMP_ENABLED;
  });

  it('skips engine startup when SNMP_ENABLED is not set (default opt-in-off behavior)', async () => {
    delete process.env.SNMP_ENABLED;
    const { module, engine } = await buildModule();
    const startSpy = vi.spyOn(engine, 'start');

    await module.init();

    expect(startSpy).not.toHaveBeenCalled();
    expect(engine.isStarted()).toBe(false);
    expect(engine.isClosed()).toBe(false);

    await module.close();
  });

  it('closes the engine on module destroy (graceful shutdown path)', async () => {
    const { module, engine } = await buildModule();
    await module.init();
    const closeSpy = vi.spyOn(engine, 'close');

    await module.close();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(engine.isClosed()).toBe(true);
  });

  it('skips close when the engine is already closed (idempotent shutdown)', async () => {
    const { module, engine } = await buildModule();
    await module.init();
    await engine.close();
    const closeSpy = vi.spyOn(engine, 'close');

    await module.close();

    expect(closeSpy).not.toHaveBeenCalled();
  });
});
