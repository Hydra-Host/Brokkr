// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from '@/contract';
import type { AuditSearch } from '@/lib/audit-search';

interface QueryArgs {
  queryKey: unknown[];
  queryData: { query: Record<string, unknown> };
  refetchInterval: number | false;
}
interface QueryResult {
  data?: { status: number; body: unknown };
  error?: unknown;
  isLoading?: boolean;
}

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn<(args: QueryArgs) => QueryResult>() }));

vi.mock('@/lib/api', () => ({ tsr: { listAuditEvents: { useQuery } } }));

import { AuditView } from './audit';

const NO_FILTERS: AuditSearch = { outcome: undefined, method: undefined, q: undefined, page: undefined };

function event(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 1,
    ts: 1_700_000_000_000,
    method: 'POST',
    path: '/api/pg/query',
    handler: 'runPgQuery',
    outcome: 'ok',
    statusCode: 200,
    durationMs: 12,
    runId: null,
    origin: { ip: '127.0.0.1', loopback: true, tokenAuth: false },
    params: null,
    error: null,
    ...over,
  };
}

function returns(body: unknown, status = 200) {
  useQuery.mockReturnValue({ data: { status, body }, error: null, isLoading: false });
}

const setSearch = vi.fn<(patch: Partial<AuditSearch>) => void>();

function show(search: Partial<AuditSearch> = {}) {
  render(<AuditView search={{ ...NO_FILTERS, ...search }} setSearch={setSearch} />);
}

function table() {
  return within(screen.getByRole('table'));
}

function clickRow(handler: string) {
  fireEvent.click(table().getByText(handler));
}

function lastQuery(): QueryArgs {
  const args = useQuery.mock.calls.at(-1);
  if (!args) throw new Error('useQuery was not called');
  return args[0];
}

function lastPatch(): Partial<AuditSearch> {
  const args = setSearch.mock.calls.at(-1);
  if (!args) throw new Error('setSearch was not called');
  return args[0];
}

beforeEach(() => {
  useQuery.mockReset();
  setSearch.mockReset();
});

afterEach(cleanup);

describe('AuditView', () => {
  it('renders a row per recorded event', () => {
    returns([event(), event({ id: 2, method: 'WS', path: '/api/fleet/shell', handler: 'WebSocket.fleetShell' })]);
    show();
    expect(table().getByText('runPgQuery')).toBeDefined();
    expect(table().getByText('WebSocket.fleetShell')).toBeDefined();
    expect(table().getByText('/api/fleet/shell')).toBeDefined();
  });

  it('spells out the origin ip, loopback grant, and token presence', () => {
    returns([event({ origin: { ip: '10.0.0.4', loopback: false, tokenAuth: true } })]);
    show();
    expect(table().getByText('10.0.0.4 · remote · token')).toBeDefined();
  });

  it('labels a system-issued event with no origin', () => {
    returns([event({ origin: null })]);
    show();
    expect(table().getByText('system')).toBeDefined();
  });

  it('colors each outcome from the status palette', () => {
    returns([event({ id: 1, outcome: 'ok' }), event({ id: 2, outcome: 'error' }), event({ id: 3, outcome: 'denied' })]);
    show();
    expect(table().getByText('ok').className).toContain('text-status-online');
    expect(table().getByText('error').className).toContain('text-status-offline');
    expect(table().getByText('denied').className).toContain('text-status-warning');
  });

  it('says the log is empty only when nothing has been recorded and nothing is filtered', () => {
    returns([]);
    show();
    expect(screen.getByText('no audit events recorded yet')).toBeDefined();
    expect(screen.queryByText('no audit events match these filters')).toBeNull();
    expect(screen.queryByText('no audit events on this page')).toBeNull();
  });

  it('blames the text filter rather than the log when it hides every fetched row', () => {
    returns([event()]);
    show({ q: 'redis' });
    expect(screen.getByText('no audit events match these filters')).toBeDefined();
    expect(screen.queryByText('no audit events recorded yet')).toBeNull();
    expect(screen.queryByText('runPgQuery')).toBeNull();
  });

  it('blames the outcome filter rather than the log when the endpoint returns nothing', () => {
    returns([]);
    show({ outcome: 'denied' });
    expect(screen.getByText('no audit events match these filters')).toBeDefined();
    expect(screen.queryByText('no audit events recorded yet')).toBeNull();
  });

  it('blames the method filter rather than the log when the endpoint returns nothing', () => {
    returns([]);
    show({ method: 'WS' });
    expect(screen.getByText('no audit events match these filters')).toBeDefined();
    expect(screen.queryByText('no audit events recorded yet')).toBeNull();
  });

  it('blames the paged-past-the-end window rather than the log', () => {
    returns([]);
    show({ page: 4 });
    expect(screen.getByText('no audit events on this page')).toBeDefined();
    expect(screen.queryByText('no audit events recorded yet')).toBeNull();
    expect(screen.queryByText('no audit events match these filters')).toBeNull();
  });

  it('warns that reads are not audited beside the method filter', () => {
    returns([]);
    show();
    expect(screen.getByText('reads (GET) are not audited')).toBeDefined();
  });

  it('keeps only the rows whose path or handler matches the filter', () => {
    returns([event(), event({ id: 2, path: '/api/redis/keys', handler: 'listRedisKeys' })]);
    show({ q: 'redis' });
    expect(table().getByText('listRedisKeys')).toBeDefined();
    expect(table().queryByText('runPgQuery')).toBeNull();
    expect(screen.getByText(/1 matching/)).toBeDefined();
  });

  it('surfaces a failed request as an error banner', () => {
    returns({ error: 'audit unavailable' }, 503);
    show();
    expect(screen.getByText('audit unavailable')).toBeDefined();
  });

  it('shows the recorded params pretty-printed once a row is selected', () => {
    returns([event({ params: '{"sql":"select 1"}' })]);
    show();
    expect(screen.getByText(/select a row/)).toBeDefined();
    clickRow('runPgQuery');
    expect(screen.getByText(/"sql": "select 1"/)).toBeDefined();
    expect(screen.queryByText(/select a row/)).toBeNull();
  });

  it('shows raw non-json params verbatim', () => {
    returns([event({ params: 'select * from "Device"' })]);
    show();
    clickRow('runPgQuery');
    expect(screen.getByText('select * from "Device"')).toBeDefined();
  });

  it('reports the denial reason of a rejected request', () => {
    returns([event({ outcome: 'denied', statusCode: 403, durationMs: null, error: 'loopback only' })]);
    show();
    clickRow('runPgQuery');
    expect(screen.getByText('loopback only')).toBeDefined();
  });

  it('dashes the duration a denial never spent and the run it never touched', () => {
    returns([event({ outcome: 'denied', statusCode: 403, durationMs: null, runId: null })]);
    show();
    expect(table().getAllByText('—')).toHaveLength(2);
  });

  it('closes the detail panel when the selected row is clicked again', () => {
    returns([event({ params: '{"sql":"select 1"}' })]);
    show();
    clickRow('runPgQuery');
    clickRow('runPgQuery');
    expect(screen.getByText(/select a row/)).toBeDefined();
  });

  it('asks the endpoint for the newest page with no filters by default', () => {
    returns([]);
    show();
    expect(lastQuery().queryData.query).toEqual({ outcome: undefined, method: undefined, limit: 100, offset: 0 });
    expect(lastQuery().refetchInterval).toBe(2000);
  });

  it('translates the url filters and page into the endpoint query', () => {
    returns([]);
    show({ outcome: 'error', method: 'POST', page: 2 });
    expect(lastQuery().queryData.query).toEqual({ outcome: 'error', method: 'POST', limit: 100, offset: 200 });
  });

  it('stops polling a paged-back window', () => {
    returns([]);
    show({ page: 1 });
    expect(lastQuery().refetchInterval).toBe(false);
  });

  it('pages older only while the page came back full', () => {
    returns([event()]);
    show();
    expect(screen.getByRole('button', { name: 'older →' }).getAttribute('disabled')).not.toBeNull();
    expect(screen.getByRole('button', { name: '← newer' }).getAttribute('disabled')).not.toBeNull();
  });

  it('writes a page step back to the url and omits the default page', () => {
    returns(Array.from({ length: 100 }, (_, i) => event({ id: i + 1 })));
    show({ page: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'older →' }));
    expect(lastPatch()).toStrictEqual({ page: 2 });
    fireEvent.click(screen.getByRole('button', { name: '← newer' }));
    expect(lastPatch()).toStrictEqual({ page: undefined });
  });

  it('returns to the newest page whenever a filter changes', () => {
    returns([]);
    show({ page: 3 });
    const [outcomeSelect, methodSelect] = screen.getAllByRole('combobox');
    fireEvent.change(outcomeSelect, { target: { value: 'denied' } });
    expect(lastPatch()).toStrictEqual({ outcome: 'denied', page: undefined });
    fireEvent.change(methodSelect, { target: { value: 'PUT' } });
    expect(lastPatch()).toStrictEqual({ method: 'PUT', page: undefined });
  });

  it('clears a chosen filter back to any', () => {
    returns([]);
    show({ outcome: 'denied', method: 'PUT' });
    const [outcomeSelect, methodSelect] = screen.getAllByRole('combobox');
    fireEvent.change(outcomeSelect, { target: { value: '' } });
    expect(lastPatch()).toStrictEqual({ outcome: undefined, page: undefined });
    fireEvent.change(methodSelect, { target: { value: '' } });
    expect(lastPatch()).toStrictEqual({ method: undefined, page: undefined });
  });
});
