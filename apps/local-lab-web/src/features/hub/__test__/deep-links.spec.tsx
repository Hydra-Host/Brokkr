// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/contract';
import type { HubSearch } from '@/lib/hub-search';

type SearchReducer = (prev: Record<string, unknown>) => HubSearch;

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

vi.mock('@/features/datastore/queues/use-queue-mutations', () => ({
  useQueueMutations: () => ({ retry: null, remove: null, busy: false }),
}));

import { JobDetailView } from '@/features/datastore/queues/job-detail';
import { MachineCard } from '@/routes/fleet';

const PLAN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DEVICE = '00000000-0000-0000-0000-000000000007';

const job = (over: Record<string, unknown> = {}) => ({
  id: `${DEVICE}-provision-${PLAN}`,
  name: 'saga.run',
  state: 'delayed' as const,
  attemptsMade: 0,
  timestamp: 1_700_000_000_000,
  processedOn: null,
  finishedOn: null,
  delay: 0,
  failedReason: null,
  deviceId: DEVICE,
  sagaName: 'provision',
  planId: PLAN,
  sealed: false,
  zoneId: null,
  payloadTruncated: false,
  stacktrace: [] as string[],
  aad: null,
  ...over,
});

const machine = (over: Partial<Machine> = {}): Machine => ({
  name: 'cpu-1',
  power: 'on',
  configured: true,
  deviceId: DEVICE,
  ...over,
});

function hubLink(): { to: string; search: SearchReducer } {
  const link = links.filter((entry) => entry.to === '/hub').at(-1);
  if (!link) throw new Error('no /hub link was rendered');
  return link;
}

beforeEach(() => {
  links.length = 0;
});

afterEach(cleanup);

describe('queue job detail links to its lifecycle job', () => {
  it('targets the hub scoped to the plan id, which is also the lifecycle job id', () => {
    render(<JobDetailView job={job()} />);

    expect(screen.getByText('lifecycle')).toBeDefined();
    expect(hubLink().search({})).toMatchObject({ tab: 'lifecycle', jobId: PLAN });
  });

  it('renders no link at all for a job that carries no plan id', () => {
    render(<JobDetailView job={job({ planId: null })} />);

    expect(screen.queryByText('lifecycle')).toBeNull();
    expect(links.some((entry) => entry.to === '/hub')).toBe(false);
  });

  it('keeps unrelated hub params the operator already had', () => {
    render(<JobDetailView job={job()} />);
    const prior = { tab: 'tokens', deviceId: 'dev-9', tokenStatus: 'ACTIVE' };

    expect(hubLink().search(prior)).toMatchObject({
      tab: 'lifecycle',
      jobId: PLAN,
      deviceId: 'dev-9',
      tokenStatus: 'ACTIVE',
    });
  });
});

describe('machine card links to its device tokens', () => {
  it('targets the hub scoped to that device', () => {
    render(
      <MachineCard
        machine={machine()}
        busy={false}
        onPower={vi.fn()}
        onConsole={vi.fn()}
        onReset={vi.fn()}
        onDiscover={vi.fn()}
        onExec={vi.fn()}
      />,
    );

    expect(screen.getByText('tokens')).toBeDefined();
    expect(hubLink().search({})).toMatchObject({ tab: 'tokens', deviceId: DEVICE });
  });

  it('renders no tokens link for a machine with no device id', () => {
    render(
      <MachineCard
        machine={machine({ deviceId: null })}
        busy={false}
        onPower={vi.fn()}
        onConsole={vi.fn()}
        onReset={vi.fn()}
        onDiscover={vi.fn()}
        onExec={vi.fn()}
      />,
    );

    expect(screen.queryByText('tokens')).toBeNull();
  });
});
