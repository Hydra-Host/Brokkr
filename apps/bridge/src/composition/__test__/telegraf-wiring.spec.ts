import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetTelegrafCacheForTests, setTelegrafCache } from '../telegraf-cache-holder';
import { type TelegrafCache } from '../telegraf-factory';
import { getTelegrafFactoryHandle, resetTelegrafFactoryForTests } from '../telegraf-singleton';
import { configureTelegrafForBridge } from '../telegraf-wiring';

class OneDeviceCache implements TelegrafCache {
  async secretHget(): Promise<string | null> {
    return null;
  }
  async get(): Promise<string | null> {
    return null;
  }
  async scan(): Promise<string[]> {
    return ['device:dev1:data'];
  }
}

async function collectActiveIds(): Promise<string[]> {
  const handle = getTelegrafFactoryHandle();
  const ids: string[] = [];
  for await (const id of handle.moduleOptions.activeDevices.iterActiveDeviceIds('')) {
    ids.push(id);
  }
  return ids;
}

describe('configureTelegrafForBridge', () => {
  beforeEach(() => {
    resetTelegrafFactoryForTests();
    resetTelegrafCacheForTests();
    setTelegrafCache(new OneDeviceCache());
  });

  afterEach(() => {
    resetTelegrafFactoryForTests();
    resetTelegrafCacheForTests();
  });

  it('wires the live cache when telegraf + orchestrator are both enabled', async () => {
    configureTelegrafForBridge({ TELEGRAF_ENABLED: 'true', BRIDGE_ORCHESTRATOR_ENABLED: 'true' });
    expect(await collectActiveIds()).toEqual(['dev1']);
  });

  it('stays inert (empty active-devices) when telegraf is disabled', async () => {
    configureTelegrafForBridge({ TELEGRAF_ENABLED: 'false', BRIDGE_ORCHESTRATOR_ENABLED: 'true' });
    expect(await collectActiveIds()).toEqual([]);
  });

  it('stays inert when the orchestrator is degraded, even with telegraf enabled', async () => {
    configureTelegrafForBridge({ TELEGRAF_ENABLED: 'true', BRIDGE_ORCHESTRATOR_ENABLED: 'false' });
    expect(await collectActiveIds()).toEqual([]);
  });
});
