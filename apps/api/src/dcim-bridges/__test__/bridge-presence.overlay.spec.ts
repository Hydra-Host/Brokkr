import { describe, expect, it, vi } from 'vitest';
import { lookupBridgePresence, OFFLINE_PRESENCE, toPresence } from '../bridge-presence.overlay';

describe('toPresence', () => {
  it('is online when registered_at is within the freshness window', () => {
    expect(toPresence({ registered_at: String(Date.now() / 1000) })).toEqual({
      online: true,
      isLeader: false,
      interfaces: [],
      activePlugins: [],
    });
  });

  it('is offline when registered_at is stale (missed check-ins)', () => {
    expect(toPresence({ registered_at: String(Date.now() / 1000 - 100) })).toEqual({
      online: false,
      isLeader: false,
      interfaces: [],
      activePlugins: [],
    });
  });

  it('is offline when registered_at is absent or unparseable', () => {
    expect(toPresence({})).toEqual({ online: false, isLeader: false, interfaces: [], activePlugins: [] });
    expect(toPresence({ registered_at: 'not-a-number' })).toEqual({ online: false, isLeader: false, interfaces: [], activePlugins: [] });
  });

  it("reads leadership from the Python-style 'True' string", () => {
    expect(toPresence({ registered_at: String(Date.now() / 1000), is_leader: 'True' }).isLeader).toBe(true);
    expect(toPresence({ registered_at: String(Date.now() / 1000), is_leader: 'False' }).isLeader).toBe(false);
  });

  it('parses interfaces_json, rendering ip/prefix from the host ip and subnet CIDR', () => {
    const raw = JSON.stringify([
      { iface: 'eth0', mac: 'AA:BB:CC:DD:EE:FF', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
      { iface: 'eth1', mac: '', subnet: 'not-a-cidr', ip: '192.168.1.2' },
    ]);

    expect(toPresence({ registered_at: String(Date.now() / 1000), interfaces_json: raw }).interfaces).toEqual([
      { name: 'eth0', macAddress: 'AA:BB:CC:DD:EE:FF', address: '10.0.0.5/24' },
      { name: 'eth1', macAddress: '', address: '192.168.1.2' },
    ]);
  });

  it('tolerates malformed interfaces_json by returning no interfaces', () => {
    expect(toPresence({ registered_at: String(Date.now() / 1000), interfaces_json: 'not json' }).interfaces).toEqual(
      [],
    );
  });
});

describe('lookupBridgePresence', () => {
  it('keys each device by id and reads its zone-scoped instance hash', async () => {
    const redis = {
      hgetall: vi.fn().mockResolvedValue({ registered_at: String(Date.now() / 1000), is_leader: 'True' }),
    };

    const result = await lookupBridgePresence(redis as never, [{ id: 'dev-1', zoneId: 'zone-a', name: 'Bridge-01' }]);

    expect(redis.hgetall).toHaveBeenCalledWith('zone-a:bridge:instance:Bridge-01');
    expect(result.get('dev-1')).toEqual({ online: true, isLeader: true, interfaces: [], activePlugins: [] });
  });

  it('resolves a device with no zone to offline without hitting Redis', async () => {
    const redis = { hgetall: vi.fn() };

    const result = await lookupBridgePresence(redis as never, [{ id: 'dev-2', zoneId: null, name: 'Bridge-02' }]);

    expect(redis.hgetall).not.toHaveBeenCalled();
    expect(result.get('dev-2')).toEqual(OFFLINE_PRESENCE);
  });
});

describe('toPresence active plugins', () => {
  it('parses active_plugins_json when online', () => {
    const presence = toPresence({
      registered_at: String(Date.now() / 1000),
      active_plugins_json: JSON.stringify([{ id: 'bridge-hello-world', version: '0.1.0' }]),
    });
    expect(presence.activePlugins).toEqual([{ id: 'bridge-hello-world', version: '0.1.0' }]);
  });

  it('returns no plugins when offline even if the hash carries them', () => {
    const presence = toPresence({
      registered_at: String(Date.now() / 1000 - 100),
      active_plugins_json: JSON.stringify([{ id: 'bridge-hello-world', version: '0.1.0' }]),
    });
    expect(presence.activePlugins).toEqual([]);
  });

  it('treats malformed or schema-invalid plugin JSON as empty', () => {
    const fresh = String(Date.now() / 1000);
    expect(toPresence({ registered_at: fresh, active_plugins_json: 'not-json' }).activePlugins).toEqual([]);
    expect(
      toPresence({ registered_at: fresh, active_plugins_json: JSON.stringify([{ nope: true }]) }).activePlugins,
    ).toEqual([]);
  });
});
