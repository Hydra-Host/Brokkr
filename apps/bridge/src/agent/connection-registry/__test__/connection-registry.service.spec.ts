import { describe, expect, it } from 'vitest';

import { ConnectionRegistry } from '../connection-registry.service';
import { createSessionHandle } from '../connection-registry.types';

function monotonicSec(): number {
  return performance.now() / 1000;
}

describe('ConnectionRegistry', () => {
  it('register/get/is_connected roundtrip', async () => {
    const reg = new ConnectionRegistry();
    const handle = await reg.register('dev-1');
    expect(reg.get('dev-1')).toBe(handle);
    expect(reg.isConnected('dev-1')).toBe(true);
    expect(reg.size()).toBe(1);
    expect(reg.sessionCount('dev-1')).toBe(1);
    expect(reg.deviceIds()).toEqual(['dev-1']);
  });

  it('unregister only clears its own handle', async () => {
    const reg = new ConnectionRegistry();
    const first = await reg.register('dev-1');
    const second = await reg.register('dev-1');

    await reg.unregister('dev-1', first);
    expect(reg.get('dev-1')).toBe(second);
    expect(reg.isConnected('dev-1')).toBe(true);
    expect(reg.sessionCount('dev-1')).toBe(1);

    await reg.unregister('dev-1', second);
    expect(reg.get('dev-1')).toBeNull();
    expect(reg.isConnected('dev-1')).toBe(false);
    expect(reg.sessionCount('dev-1')).toBe(0);
  });

  it('second register coexists with first (no eviction)', async () => {
    const reg = new ConnectionRegistry();
    const first = await reg.register('dev-1');
    const second = await reg.register('dev-1');

    expect(first.cancelled.isSet()).toBe(false);
    expect(second.cancelled.isSet()).toBe(false);
    expect(reg.sessionCount('dev-1')).toBe(2);

    expect(reg.get('dev-1')).toBe(first);

    await reg.unregister('dev-1', first);
    expect(reg.get('dev-1')).toBe(second);
  });

  it('get skips cancelled handles', async () => {
    const reg = new ConnectionRegistry();
    const a = await reg.register('dev-1');
    const b = await reg.register('dev-1');
    a.cancelled.set();
    expect(reg.get('dev-1')).toBe(b);
  });

  it('get prefers newer session when oldest is draining', async () => {
    const reg = new ConnectionRegistry();
    const draining = await reg.register('dev-1');
    const fresh = await reg.register('dev-1');
    draining.cancelled.set();

    expect(reg.get('dev-1')).toBe(fresh);
    expect(reg.sessionCount('dev-1')).toBe(2);

    await reg.unregister('dev-1', draining);
    expect(reg.get('dev-1')).toBe(fresh);
    expect(reg.sessionCount('dev-1')).toBe(1);
  });

  it('get deprioritizes recently timed-out handles', async () => {
    const reg = new ConnectionRegistry();
    const wedged = await reg.register('dev-1');
    const healthy = await reg.register('dev-1');
    wedged.lastEnqueueTimeoutAt = monotonicSec();
    expect(reg.get('dev-1')).toBe(healthy);
  });

  it('falls back when every handle recently timed out (returns oldest)', async () => {
    const reg = new ConnectionRegistry();
    const first = await reg.register('dev-1');
    const second = await reg.register('dev-1');
    const now = monotonicSec();
    first.lastEnqueueTimeoutAt = now;
    second.lastEnqueueTimeoutAt = now;
    expect(reg.get('dev-1')).toBe(first);
  });

  it('restores FIFO preference once timeout ages out of the window', async () => {
    const reg = new ConnectionRegistry();
    const older = await reg.register('dev-1');
    await reg.register('dev-1');
    older.lastEnqueueTimeoutAt = monotonicSec() - 120.0;
    expect(reg.get('dev-1')).toBe(older);
  });

  it('wait_for_registration skips cancelled handle', async () => {
    const reg = new ConnectionRegistry();
    const draining = await reg.register('dev-w', { agentVersion: '1.0.0' });
    draining.cancelled.set();

    const waiterPromise = reg.waitForRegistration('dev-w', 2.0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const fresh = await reg.register('dev-w', { agentVersion: '1.0.0' });
    const got = await waiterPromise;
    expect(got).toBe(fresh);
  });

  it('concurrent register race is safe (all sessions coexist)', async () => {
    const reg = new ConnectionRegistry();
    const results = await Promise.all(Array.from({ length: 10 }, () => reg.register('dev-1')));
    expect(reg.sessionCount('dev-1')).toBe(10);
    const ids = new Set(results.map((h) => h));
    expect(ids.size).toBe(10);
  });

  it('multiple devices are independent', async () => {
    const reg = new ConnectionRegistry();
    const a = await reg.register('dev-a');
    const b = await reg.register('dev-b');
    expect(reg.size()).toBe(2);
    expect(reg.get('dev-a')).toBe(a);
    expect(reg.get('dev-b')).toBe(b);
    await reg.unregister('dev-a', a);
    expect(reg.get('dev-a')).toBeNull();
    expect(reg.get('dev-b')).toBe(b);
  });

  it('wait_for_registration returns first match', async () => {
    const reg = new ConnectionRegistry();
    const waiter = reg.waitForRegistration('dev-x', 2.0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const h = await reg.register('dev-x', { agentVersion: '1.0.0' });
    const got = await waiter;
    expect(got).toBe(h);
  });

  it('wait_for_registration skips wrong-version session', async () => {
    const reg = new ConnectionRegistry();
    const old = await reg.register('dev-v', { agentVersion: '0.9.0' });

    const waiter = reg.waitForRegistration('dev-v', 2.0, { expectVersion: '1.0.0' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fresh = await reg.register('dev-v', { agentVersion: '1.0.0' });
    const got = await waiter;
    expect(got).toBe(fresh);
    expect(got).not.toBe(old);
  });

  it('register with different agent_version cancels prior handles', async () => {
    const reg = new ConnectionRegistry();
    const stale = await reg.register('dev-1', { agentVersion: '604b089a' });
    expect(stale.cancelled.isSet()).toBe(false);

    const fresh = await reg.register('dev-1', { agentVersion: '8ac43e18' });

    expect(stale.cancelled.isSet()).toBe(true);
    expect(fresh.cancelled.isSet()).toBe(false);

    expect(reg.get('dev-1')).toBe(fresh);
    expect(reg.sessionCount('dev-1')).toBe(2);
  });

  it('register with same agent_version does not cancel prior', async () => {
    const reg = new ConnectionRegistry();
    const first = await reg.register('dev-1', { agentVersion: '8ac43e18' });
    const second = await reg.register('dev-1', { agentVersion: '8ac43e18' });
    expect(first.cancelled.isSet()).toBe(false);
    expect(second.cancelled.isSet()).toBe(false);
    expect(reg.sessionCount('dev-1')).toBe(2);
  });

  it('empty agent_version does not trigger eviction', async () => {
    const reg = new ConnectionRegistry();
    const versioned = await reg.register('dev-1', { agentVersion: '8ac43e18' });
    const unversioned = await reg.register('dev-1');
    expect(versioned.cancelled.isSet()).toBe(false);
    expect(unversioned.cancelled.isSet()).toBe(false);

    const reg2 = new ConnectionRegistry();
    const a = await reg2.register('dev-2');
    const b = await reg2.register('dev-2', { agentVersion: '8ac43e18' });
    expect(a.cancelled.isSet()).toBe(false);
    expect(b.cancelled.isSet()).toBe(false);
  });

  it('SessionHandle.peerIp defaults to null', () => {
    const h = createSessionHandle({ deviceId: '42' });
    expect(h.peerIp).toBeNull();
  });

  it('SessionHandle accepts peerIp', () => {
    const h = createSessionHandle({ deviceId: '42', peerIp: '10.0.0.5' });
    expect(h.peerIp).toBe('10.0.0.5');
  });

  it('register records peerIp on handle', async () => {
    const reg = new ConnectionRegistry();
    const h = await reg.register('42', { peerIp: '10.0.0.5' });
    expect(h.peerIp).toBe('10.0.0.5');
  });

  it('register without peerIp leaves null', async () => {
    const reg = new ConnectionRegistry();
    const h = await reg.register('42');
    expect(h.peerIp).toBeNull();
  });
});
