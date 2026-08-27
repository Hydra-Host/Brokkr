// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StackConfig } from '@/contract';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn(), refetch: vi.fn() }));
vi.mock('@/lib/api', () => ({ tsr: { getStackConfig: { useQuery: mocks.useQuery } } }));

import { SEED_BLOCKED_MESSAGE, useStackConfigForm } from './use-stack-config-form';

const config = (over: Partial<StackConfig> = {}): StackConfig => ({
  seeded: true,
  knobs: { hub: [], spoke: [] },
  ports: { hub: [], spoke: [] },
  servicePorts: [
    { key: 'postgres', path: 'ports.postgres', group: 'Datastores', label: 'Postgres', value: 5432 },
    { key: 'grafana', path: 'ports.grafana', group: 'Observability', label: 'Grafana', value: 3010, readOnly: true },
  ],
  values: { hub: { LOG_LEVEL: 'debug' }, spoke: { LOG_LEVEL: 'info' } },
  topology: { zones: 1, bridges: 1 },
  slot: 0,
  identity: { pg: { user: 'brokkr', password: 'password', db: 'brokkr' }, orgId: 'org-1' },
  osLayerCache: { originHost: 'assets.local', resolvers: '1.1.1.1' },
  lan: { expose: false },
  telemetry: { enable: false },
  ...over,
});

const unseeded = () => config({ seeded: false, values: { hub: {}, spoke: {} } });

const setConfig = (body: StackConfig) =>
  mocks.useQuery.mockReturnValue({ data: { status: 200, body }, error: null, refetch: mocks.refetch });

const lastQuery = () => mocks.useQuery.mock.calls.at(-1)?.[0];

describe('useStackConfigForm', () => {
  beforeEach(() => {
    mocks.useQuery.mockReset();
    mocks.refetch.mockReset();
    setConfig(config());
  });

  afterEach(cleanup);

  it('hydrates every section from the config query', () => {
    const { result } = renderHook(() => useStackConfigForm());

    expect(result.current.valsOf('hub')).toEqual({ LOG_LEVEL: 'debug' });
    expect(result.current.valsOf('spoke')).toEqual({ LOG_LEVEL: 'info' });
    expect(result.current.identity.orgId).toBe('org-1');
    expect(result.current.osLayer).toEqual({ originHost: 'assets.local', resolvers: '1.1.1.1' });
    expect(result.current.dirty).toBe(false);
  });

  it('hydrates only the editable service ports', () => {
    const { result } = renderHook(() => useStackConfigForm());

    expect(result.current.portVals).toEqual({ postgres: '5432' });
  });

  it('reports the catalog and load error from the query', () => {
    const { result } = renderHook(() => useStackConfigForm());
    expect(result.current.catalog?.topology).toEqual({ zones: 1, bridges: 1 });
    expect(result.current.error).toBeNull();

    cleanup();
    mocks.useQuery.mockReturnValue({ data: undefined, error: new Error('boom'), refetch: mocks.refetch });
    const failed = renderHook(() => useStackConfigForm());

    expect(failed.result.current.catalog).toBeNull();
    expect(failed.result.current.error).toBe('boom');
    expect(failed.result.current.seedFailed).toBe(false);
  });

  it('does not clobber a dirty form when a refetch delivers a fresh response', () => {
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => result.current.setVal('hub', 'LOG_LEVEL', 'trace'));
    rerender();
    expect(result.current.dirty).toBe(true);

    act(() => setConfig(config()));
    rerender();

    expect(result.current.valsOf('hub')).toEqual({ LOG_LEVEL: 'trace' });
  });

  it('does not revert to the pre-save body when a successful save clears dirty', () => {
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => result.current.setVal('hub', 'LOG_LEVEL', 'trace'));
    rerender();

    act(() => result.current.markSaved());
    rerender();

    expect(result.current.dirty).toBe(false);
    expect(result.current.valsOf('hub')).toEqual({ LOG_LEVEL: 'trace' });
  });

  it('rehydrates once the post-save refetch delivers the saved body', () => {
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => result.current.setVal('hub', 'LOG_LEVEL', 'trace'));
    rerender();
    act(() => result.current.markSaved());
    rerender();

    act(() => setConfig(config({ values: { hub: { LOG_LEVEL: 'server-normalized' }, spoke: {} } })));
    rerender();

    expect(result.current.valsOf('hub')).toEqual({ LOG_LEVEL: 'server-normalized' });
  });

  it('collects every edited section into the save body', () => {
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => {
      result.current.setVal('spoke', 'PORT', '8001');
      result.current.setPort('postgres', '6000');
      result.current.updateIdentity((s) => ({ ...s, orgId: 'org-2' }));
      result.current.updateOsLayer((s) => ({ ...s, resolvers: '8.8.8.8' }));
      result.current.updateLan((s) => ({ expose: !s.expose }));
      result.current.updateTelemetry((s) => ({ enable: !s.enable }));
    });
    rerender();

    expect(result.current.dirty).toBe(true);
    expect(result.current.saveBody()).toEqual({
      slot: 0,
      entries: {
        'stackDefaults.spoke.PORT': '8001',
        'ports.postgres': '6000',
        'identity.orgId': 'org-2',
        'osLayerCache.resolvers': '8.8.8.8',
        'lan.expose': 'true',
        'telemetry.enable': 'true',
      },
    });
  });

  it('clamps the stack slot to 0–46 and collects it into the save body', () => {
    const { result, rerender } = renderHook(() => useStackConfigForm());
    expect(result.current.slot).toBe(0);

    act(() => result.current.setSlot(3));
    rerender();
    expect(result.current.dirty).toBe(true);
    expect(result.current.saveBody().slot).toBe(3);

    act(() => result.current.setSlot(99));
    rerender();
    expect(result.current.slot).toBe(46);

    act(() => result.current.setSlot(-1));
    rerender();
    expect(result.current.slot).toBe(0);
  });

  it('offers no instance-count control at all, because nothing consumed the number', () => {
    const { result } = renderHook(() => useStackConfigForm());

    expect('setCount' in result.current).toBe(false);
    expect('counts' in result.current).toBe(false);
  });

  it('sends every edited port and lets the server name the ones it refuses', () => {
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => {
      result.current.setPort('postgres', '');
      result.current.setPort('redis', '70000');
      result.current.setPort('nginx', '8080');
    });
    rerender();

    expect(result.current.saveBody().entries).toEqual({
      'ports.postgres': '',
      'ports.redis': '70000',
      'ports.nginx': '8080',
    });
  });

  it('sends only the paths that differ from the body it was filled from', () => {
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => result.current.setVal('hub', 'LOG_LEVEL', 'warn'));
    rerender();

    expect(result.current.saveBody().entries).toEqual({ 'stackDefaults.hub.LOG_LEVEL': 'warn' });
  });

  it('sends nothing at all when the form matches what it loaded', () => {
    const { result } = renderHook(() => useStackConfigForm());

    expect(result.current.saveBody().entries).toEqual({});
  });

  it('polls for a live config only while the seed has failed', () => {
    const { rerender } = renderHook(() => useStackConfigForm());
    expect(lastQuery()).toEqual({ queryKey: ['stack-config'], refetchInterval: false });

    act(() => setConfig(unseeded()));
    rerender();
    expect(lastQuery()).toEqual({ queryKey: ['stack-config'], refetchInterval: 5000 });

    act(() => setConfig(config()));
    rerender();
    expect(lastQuery()).toEqual({ queryKey: ['stack-config'], refetchInterval: false });
  });

  it('blocks the save only once an unseeded form has been edited', () => {
    setConfig(unseeded());
    const { result, rerender } = renderHook(() => useStackConfigForm());
    expect(result.current.seedFailed).toBe(true);
    expect(result.current.saveBlocked).toBe(false);

    act(() => result.current.setVal('hub', 'LOG_LEVEL', 'warn'));
    rerender();

    expect(result.current.saveBlocked).toBe(true);
  });

  it('adopts the seeded body over a pending edit built on bare defaults', () => {
    setConfig(unseeded());
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => result.current.setVal('hub', 'LOG_LEVEL', 'warn'));
    rerender();
    expect(result.current.dirty).toBe(true);

    act(() => setConfig(config()));
    rerender();

    expect(result.current.valsOf('hub')).toEqual({ LOG_LEVEL: 'debug' });
    expect(result.current.dirty).toBe(false);
    expect(result.current.saveBlocked).toBe(false);
  });

  it('clears a stale refusal when the seeded body is adopted', () => {
    setConfig(unseeded());
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => result.current.setVal('hub', 'LOG_LEVEL', 'warn'));
    rerender();
    act(() => result.current.markSaveRefused());
    rerender();
    expect(result.current.saveError).toBe(SEED_BLOCKED_MESSAGE);

    act(() => setConfig(config()));
    rerender();

    expect(result.current.saveError).toBeNull();
  });

  it('re-arms the adopt for a second unseeded window in one mount', () => {
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => setConfig(unseeded()));
    rerender();
    expect(result.current.valsOf('hub')).toEqual({});

    act(() => result.current.setVal('hub', 'LOG_LEVEL', 'warn'));
    rerender();
    act(() => setConfig(config()));
    rerender();

    expect(result.current.valsOf('hub')).toEqual({ LOG_LEVEL: 'debug' });
  });

  it('keeps a dirty edit when another unseeded response arrives', () => {
    setConfig(unseeded());
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => result.current.setVal('hub', 'LOG_LEVEL', 'warn'));
    rerender();
    act(() => setConfig(unseeded()));
    rerender();

    expect(result.current.valsOf('hub')).toEqual({ LOG_LEVEL: 'warn' });
    expect(result.current.dirty).toBe(true);
  });

  it('surfaces a thrown save failure and falls back to a generic reason', () => {
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => result.current.markSaveFailed({ status: 503, body: { error: 'stack overlay state is unknown' } }));
    rerender();
    expect(result.current.saveError).toBe('stack overlay state is unknown');

    act(() => result.current.markSaveFailed(undefined));
    rerender();
    expect(result.current.saveError).toBe('saving the stack config failed');
  });

  it('clears the last failure on a successful save', () => {
    const { result, rerender } = renderHook(() => useStackConfigForm());

    act(() => result.current.markSaveFailed(new Error('boom')));
    rerender();
    expect(result.current.saveError).toBe('boom');

    act(() => result.current.markSaved());
    rerender();

    expect(result.current.saveError).toBeNull();
  });
});
