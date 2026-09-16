// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscoverySync, StorageCategory, StorageItem, StorageState, StorageVerifyResult } from '@/contract';

type VerifyMutate = (
  input: { body: Record<string, never> },
  opts: { onSuccess: (res: { status: 200; body: StorageVerifyResult }) => void },
) => void;

type RunMutate = (
  input: { body: Record<string, never> },
  opts: { onSuccess: (res: { status: 200; body: { runId: string } }) => void },
) => void;

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  mutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  verifyMutate: vi.fn<VerifyMutate>(),
  buildMutate: vi.fn<RunMutate>(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  tsr: {
    getStorageState: { useQuery: mocks.state },
    wipeStorage: { useMutation: mocks.mutation },
    resyncStorage: { useMutation: mocks.mutation },
    verifyStorage: { useMutation: () => ({ mutate: mocks.verifyMutate, isPending: false }) },
    buildAgent: { useMutation: () => ({ mutate: mocks.buildMutate, isPending: false }) },
  },
}));
vi.mock('@/lib/use-poll', () => ({ usePoll: () => false }));
vi.mock('@/lib/toast', () => ({ useToast: () => ({ error: mocks.toastError, success: vi.fn() }) }));
vi.mock('@/lib/use-log-stream', () => ({
  usePaintedHtml: () => ({ current: null }),
  useLogStream: () => ({
    logHtml: '',
    logRef: { current: null },
    open: vi.fn(),
    clear: vi.fn(),
    follow: true,
    setFollow: vi.fn(),
    degraded: false,
    disconnected: false,
  }),
}));

import { LastSyncLine, StoragePage } from './storage';

const NOW = 1_700_000_000_000;

const item = (flavor: string, name: string, present = true): StorageItem => ({
  name,
  present,
  sizeBytes: present ? 10 : 0,
  mtimeMs: present ? 1_000 : 0,
  path: `/srv/spoke/brokkr-live/${flavor}/arm64/${name}`,
  flavor,
  arch: 'arm64',
  served: present,
});

const category = (over: Partial<StorageCategory> = {}): StorageCategory => ({
  id: 'discovery-images',
  label: 'Discovery images (synced)',
  present: true,
  sizeBytes: 30,
  fileCount: 3,
  mtimeMs: 1_000,
  wipeable: true,
  detail: '3 files',
  path: '/srv/spoke/brokkr-live',
  items: [item('light', 'vmlinuz'), item('light', 'initrd.img'), item('light', 'brokkr-discovery.iso')],
  ...over,
});

const state = (over: Partial<StorageState> = {}): StorageState => ({
  totalBytes: 30,
  provenance: {
    version: '1.1.9',
    baseUrl: 'https://origin.example/brokkr-live',
    originHost: 'origin.example',
    architectures: ['arm64'],
    hostArch: 'arm64',
    lastSyncedMs: 1_000,
    flavors: [
      { name: 'light', present: true, fileCount: 3, sizeBytes: 30 },
      { name: 'full', present: false, fileCount: 0, sizeBytes: 0 },
    ],
  },
  discoveryReachable: true,
  discoveryOk: true,
  lastSync: null,
  categories: [category()],
  ...over,
});

const sync = (over: Partial<DiscoverySync> = {}): DiscoverySync => ({
  at: NOW - 120_000,
  outcome: 'ok',
  error: null,
  baseUrl: 'https://assets.example/brokkr-live',
  version: 'latest-dev',
  flavors: ['light'],
  ...over,
});

const verified = (results: StorageVerifyResult['results']) =>
  mocks.verifyMutate.mockImplementation((_input, opts) => opts.onSuccess({ status: 200, body: { results } }));

beforeEach(() => {
  mocks.toastError.mockClear();
  mocks.verifyMutate.mockReset();
  mocks.buildMutate.mockReset();
  mocks.state.mockReturnValue({ data: { status: 200, body: state() }, refetch: vi.fn() });
});

afterEach(cleanup);

describe('StoragePage provenance', () => {
  it('prints one provenance line per flavor and no hardcoded flavor name', () => {
    render(<StoragePage />);

    const lines = screen.getAllByTestId('provenance-line').map((el) => el.textContent);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^light 1\.1\.9 · arm64 · origin origin\.example · 3 files$/);
    expect(lines[1]).toMatch(/^full 1\.1\.9 · arm64 · origin origin\.example · not synced$/);
  });
});

describe('StoragePage verify shas', () => {
  it('shows the verify cause beside each file', () => {
    verified([
      { flavor: 'light', arch: 'arm64', name: 'vmlinuz', status: 'match', manifestError: null },
      { flavor: 'light', arch: 'arm64', name: 'initrd.img', status: 'stale', manifestError: null },
      { flavor: 'light', arch: 'arm64', name: 'brokkr-discovery.iso', status: 'no-local-sha', manifestError: null },
    ]);
    render(<StoragePage />);

    fireEvent.click(screen.getByText('verify shas'));

    expect(screen.getByText('match').className).toContain('text-status-online');
    expect(screen.getByText('stale').className).toContain('text-status-offline');
    expect(screen.getByText('no-local-sha').className).toContain('text-status-warning');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('toasts when the manifest was unreachable for every architecture', () => {
    verified(
      ['vmlinuz', 'initrd.img', 'brokkr-discovery.iso'].map((name) => ({
        flavor: 'light',
        arch: 'arm64',
        name,
        status: 'manifest-unreachable',
        manifestError: 'timed out after 20s',
      })),
    );
    render(<StoragePage />);

    fireEvent.click(screen.getByText('verify shas'));

    expect(screen.getAllByText('manifest-unreachable — timed out after 20s')).toHaveLength(3);
    expect(mocks.toastError).toHaveBeenCalledWith('manifest unreachable for every architecture');
  });
});

describe('StoragePage built artifacts', () => {
  const built = category({
    id: 'built-artifacts',
    label: 'Built initrds',
    wipeable: true,
    detail: 'built by Build → agent; wiping needs a rebuild',
    path: '/srv/spoke/initrd-builds',
    items: [],
  });

  it('offers a rebuild beside wipe for built artifacts', () => {
    mocks.buildMutate.mockImplementation((_input, opts) => opts.onSuccess({ status: 200, body: { runId: 'run-7' } }));
    mocks.state.mockReturnValue({ data: { status: 200, body: state({ categories: [built] }) }, refetch: vi.fn() });
    render(<StoragePage />);

    const row = screen.getByText('rebuild').parentElement;
    expect(row?.textContent).toBe('rebuildwipe');

    fireEvent.click(screen.getByText('rebuild'));

    expect(mocks.buildMutate).toHaveBeenCalledWith({ body: {} }, expect.anything());
    expect(screen.getByText('rebuild agent + initrd')).toBeTruthy();
  });

  it('offers no rebuild on the other categories', () => {
    render(<StoragePage />);

    expect(screen.queryByText('rebuild')).toBeNull();
  });
});

describe('LastSyncLine', () => {
  it('prints the last sync outcome and error on the storage page', () => {
    render(<LastSyncLine lastSync={sync({ outcome: 'failed', error: 'manifest fetch returned 404' })} nowMs={NOW} />);

    expect(screen.getByText(/last sync/).textContent).toContain('last sync 2m ago · failed');
    expect(screen.getByText('manifest fetch returned 404')).toBeDefined();
  });

  it('prints the time and outcome without an error line when the pass succeeded', () => {
    render(<LastSyncLine lastSync={sync()} nowMs={NOW} />);

    expect(screen.getByText(/last sync/).textContent).toBe('last sync 2m ago · ok');
  });

  it('prints the time and outcome when no sync was needed', () => {
    render(<LastSyncLine lastSync={sync({ outcome: 'skipped' })} nowMs={NOW} />);

    expect(screen.getByText(/last sync/).textContent).toBe('last sync 2m ago · skipped');
  });

  it('says no pass has been reported when the spoke has none yet', () => {
    render(<LastSyncLine lastSync={null} nowMs={NOW} />);

    expect(screen.getByText(/last sync/).textContent).toBe('last sync none reported');
  });
});
