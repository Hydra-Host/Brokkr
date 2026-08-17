// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/contract';
import type { DatastoreSearch } from '@/lib/datastore-search';

import { MachineCard } from './fleet';

type SearchReducer = (prev: Partial<DatastoreSearch>) => DatastoreSearch;

const { links } = vi.hoisted(() => ({ links: [] as { to: string; search: SearchReducer }[] }));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({
    to,
    search,
    children,
    className,
  }: {
    to: string;
    search: SearchReducer;
    children: ReactNode;
    className?: string;
  }) => {
    links.push({ to, search });
    return (
      <a href={to} className={className}>
        {children}
      </a>
    );
  },
}));

function machine(over: Partial<Machine> = {}): Machine {
  return { name: 'cpu-1', power: 'on', configured: true, deviceId: 'dev-1', ...over };
}

function renderCard(over: Partial<Machine> = {}) {
  render(
    <MachineCard
      machine={machine(over)}
      busy={false}
      onPower={vi.fn()}
      onConsole={vi.fn()}
      onReset={vi.fn()}
      onDiscover={vi.fn()}
      onExec={vi.fn()}
    />,
  );
}

function linkTo(to: string): SearchReducer {
  const link = links.filter((entry) => entry.to === to).at(-1);
  if (!link) throw new Error(`no ${to} link was rendered`);
  return link.search;
}

function queuesReducer(): SearchReducer {
  return linkTo('/datastore');
}

const priorSearch: DatastoreSearch = {
  tab: 'pg',
  schema: 'public',
  table: 'Device',
  page: 3,
  tableFilter: 'dev',
  key: 'zone:1:prefix:2:config:dhcp',
  match: '*:device:*',
  metric: 'up',
  metricFilter: 'node',
  queuePrefix: '11111111-2222-3333-4444-555555555555',
  queueName: 'lifecycle',
  queueFilter: 'inbox',
  jobState: 'failed',
  jobId: '66666666-7777-8888-9999-000000000000-provision',
  deviceId: '66666666-7777-8888-9999-000000000000',
};

beforeEach(() => {
  links.length = 0;
});

afterEach(cleanup);

describe('MachineCard queues deep-link', () => {
  it('links to the datastore route', () => {
    renderCard();
    expect(screen.getByText('queues')).toBeDefined();
    expect(links.filter((entry) => entry.to === '/datastore')).toHaveLength(1);
  });

  it('lands on the queues tab scoped to this machine device', () => {
    renderCard({ deviceId: '00000000-0000-0000-0000-000000000007' });
    expect(queuesReducer()({})).toMatchObject({
      tab: 'queues',
      deviceId: '00000000-0000-0000-0000-000000000007',
    });
  });

  it('leaves the job state filter unset so every in-flight job shows', () => {
    renderCard();
    expect(queuesReducer()({}).jobState).toBeUndefined();
  });

  it('preserves every unrelated param the operator already had in the url', () => {
    renderCard({ deviceId: 'dev-9' });
    expect(queuesReducer()(priorSearch)).toEqual({ ...priorSearch, tab: 'queues', deviceId: 'dev-9' });
  });

  it('renders no link for a machine with no device id', () => {
    renderCard({ name: 'ghost', configured: false, deviceId: null });
    expect(screen.queryByText('queues')).toBeNull();
    expect(links).toHaveLength(0);
  });
});
