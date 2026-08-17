import { RESTART_STALE_AFTER_MS, type RestartState, type RestartStatus } from '@repo/local-lab-contract';
import { describe, expect, it } from 'vitest';

import { connectionState, restartBanner } from './use-restart-state';

const NOW = 10_000_000;

const idle: RestartState = { status: 'idle' };

const marked = (status: Exclude<RestartStatus, 'idle'>, startedAt = NOW - 1_000): RestartState => ({
  status,
  startedAt,
  reason: 'reinit (nuke + rebuild)',
  opId: 'reinit',
  runId: 'r1',
  logPath: '/state/lab-restart.log',
});

const ask = (over: Partial<Parameters<typeof restartBanner>[0]> = {}) =>
  restartBanner({ state: idle, isError: false, stamp: null, now: NOW, ...over });

describe('restartBanner', () => {
  it('renders nothing at all only for idle', () => {
    expect(ask({ state: idle })).toBeNull();
  });

  it('renders every status the server does not call idle', () => {
    for (const status of ['pending', 'stale', 'failed'] as const) {
      expect(ask({ state: marked(status) })?.variant).toBe(status);
    }
  });

  it('carries the stage and log path straight off the marker', () => {
    expect(ask({ state: marked('pending') })).toEqual({
      variant: 'pending',
      reason: 'reinit (nuke + rebuild)',
      logPath: '/state/lab-restart.log',
      opId: 'reinit',
    });
  });

  it('cannot swallow a failure the way a pending boolean could', () => {
    const banner = ask({ state: marked('failed') });

    expect(banner?.variant).toBe('failed');
    expect(banner?.logPath).toBe('/state/lab-restart.log');
  });

  it('holds the recreation through the api-down window on the launch stamp alone', () => {
    const banner = ask({ state: null, isError: true, stamp: { opId: 'reinit', at: NOW - 1_000 } });

    expect(banner?.variant).toBe('pending');
    expect(banner?.opId).toBe('reinit');
  });

  it('holds the recreation through the api-down window on the last in-flight answer without a stamp', () => {
    expect(ask({ state: marked('pending'), isError: true })?.variant).toBe('pending');
  });

  it('reads an api outage with no recreation evidence as a bare unreachable', () => {
    expect(ask({ state: idle, isError: true })?.variant).toBe('unreachable');
    expect(ask({ state: null, isError: true })?.variant).toBe('unreachable');
  });

  it('lets any recreation evidence outrank the bare unreachable', () => {
    expect(ask({ state: marked('pending'), isError: true })?.variant).toBe('pending');
    expect(ask({ state: marked('failed'), isError: true })?.variant).toBe('failed');
    expect(ask({ state: null, isError: true, stamp: { opId: 'reinit', at: NOW } })?.variant).toBe('pending');
  });

  it('ignores a stale idle body on a failed poll when the stamp says recreating', () => {
    expect(ask({ state: idle, isError: true, stamp: { opId: 'purge', at: NOW } })?.variant).toBe('pending');
  });

  it('lets the server status override the stamp the moment the api answers again', () => {
    expect(ask({ state: idle, stamp: { opId: 'reinit', at: NOW } })).toBeNull();
    expect(ask({ state: marked('failed'), stamp: { opId: 'reinit', at: NOW } })?.variant).toBe('failed');
  });

  it('keeps holding stale rather than demoting it to a spinner during an outage', () => {
    expect(ask({ state: marked('stale'), isError: true })?.variant).toBe('stale');
  });

  it('escalates an api-down recreation past the bound the server cannot report while it is down', () => {
    const at = NOW - RESTART_STALE_AFTER_MS - 1;

    expect(ask({ state: null, isError: true, stamp: { opId: 'reinit', at } })?.variant).toBe('stale');
  });

  it('escalates off the marker s own start time when the stamp is gone with the session', () => {
    const state = marked('pending', NOW - RESTART_STALE_AFTER_MS - 1);

    expect(ask({ state, isError: true })?.variant).toBe('stale');
  });

  it('still spins inside the bound', () => {
    const at = NOW - RESTART_STALE_AFTER_MS + 1_000;

    expect(ask({ state: null, isError: true, stamp: { opId: 'reinit', at } })?.variant).toBe('pending');
  });

  it('keeps explaining a recorded failure when the api goes down again after reporting it', () => {
    const banner = ask({ state: marked('failed'), isError: true });

    expect(banner?.variant).toBe('failed');
    expect(banner?.logPath).toBe('/state/lab-restart.log');
  });

  it('lets a relaunch outrank the failure the marker last reported', () => {
    const banner = ask({ state: marked('failed'), isError: true, stamp: { opId: 'reinit', at: NOW } });

    expect(banner?.variant).toBe('pending');
  });
});

describe('connectionState', () => {
  it('is offline while the poll errors, whatever body is held', () => {
    expect(connectionState(true, true)).toBe('offline');
    expect(connectionState(true, false)).toBe('offline');
  });

  it('is connecting before the first answer and online after it', () => {
    expect(connectionState(false, false)).toBe('connecting');
    expect(connectionState(false, true)).toBe('online');
  });
});
