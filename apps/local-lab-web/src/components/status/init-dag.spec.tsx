// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InitTask } from '@/contract';
import { initAggregateState, initFocusTask } from '@/contract';

import { InitDagStrip, initSummary } from './init-dag';

const task = (over: Partial<InitTask> = {}): InitTask => ({
  name: 'hub:migrate',
  label: 'Hub DB migrate',
  state: 'completed',
  exitCode: 0,
  detail: null,
  updatedAt: 1_000,
  ...over,
});

const roster = (): InitTask[] => [
  task({ name: 'apps:init', label: 'Control center build', state: 'completed' }),
  task({ name: 'hub:init', label: 'Hub build', state: 'pending', exitCode: null }),
  task({ name: 'hub:migrate', label: 'Hub DB migrate', state: 'running', exitCode: null }),
  task({ name: 'sim:seed', label: 'Sim seed', state: 'failed', exitCode: 1, detail: 'psql: connection refused' }),
];

const renderStrip = (tasks: InitTask[], open = false) =>
  render(<InitDagStrip tasks={tasks} open={open} onToggle={vi.fn()} onView={vi.fn()} />);

describe('InitDagStrip collapsed', () => {
  afterEach(cleanup);

  it('reports a settled roster as one counted line with no log button', () => {
    renderStrip([task({ name: 'a' }), task({ name: 'b' })]);

    expect(screen.getByText(/· 2 completed/)).toBeTruthy();
    expect(screen.queryByText('log')).toBeNull();
  });

  it('counts the completed tasks when the rest never ran', () => {
    renderStrip([task({ name: 'a' }), task({ name: 'b', state: 'pending', exitCode: null })]);

    expect(screen.getByText(/· 1\/2 completed/)).toBeTruthy();
  });

  it('names the running task and the progress without expanding', () => {
    renderStrip([task({ name: 'apps:init' }), task({ name: 'hub:migrate', state: 'running', exitCode: null })]);

    expect(screen.getByText(/hub:migrate running · 1\/2/)).toBeTruthy();
    expect(screen.getByText('log')).toBeTruthy();
  });

  it('makes a failure and its exit code visible while collapsed', () => {
    const { container } = renderStrip(roster());

    expect(screen.getByText(/sim:seed failed exit 1 · 1\/4/)).toBeTruthy();
    expect(container.querySelectorAll('.text-status-offline').length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/Control center build/);
  });

  it('renders no task rows until it is opened', () => {
    renderStrip(roster());

    expect(screen.queryByText('Hub DB migrate')).toBeNull();
  });

  it('opens the focus task’s log from the collapsed line', async () => {
    const onView = vi.fn();
    render(<InitDagStrip tasks={roster()} open={false} onToggle={vi.fn()} onView={onView} />);

    screen.getByText('log').click();

    expect(onView).toHaveBeenCalledWith('sim:seed');
  });

  it('does not pulse while every task is inert', () => {
    const { container } = renderStrip([task({ name: 'a' }), task({ name: 'b', state: 'pending', exitCode: null })]);

    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
  });
});

describe('InitDagStrip expanded', () => {
  afterEach(cleanup);

  it('renders one row per task carrying its state', () => {
    renderStrip(roster(), true);

    expect(screen.getByText('Control center build')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('not run')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('failed exit 1')).toBeTruthy();
  });

  it('gives every row no border and no separate log button', () => {
    const { container } = renderStrip(roster(), true);

    expect(container.querySelectorAll('.border')).toHaveLength(0);
    expect(screen.queryAllByText('logs')).toHaveLength(0);
  });

  it('opens a task’s log from the row itself', () => {
    const onView = vi.fn();
    render(<InitDagStrip tasks={roster()} open onToggle={vi.fn()} onView={onView} />);

    screen.getByText('Hub build').click();

    expect(onView).toHaveBeenCalledWith('hub:init');
  });

  it('says a pending task did not run rather than implying it is queued', () => {
    const { container } = renderStrip([task({ name: 'hub:init', state: 'pending', exitCode: null })], true);

    expect(screen.getByText('not run')).toBeTruthy();
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/queued|waiting|pending/i);
  });

  it('pulses the strip and the one growing task, nothing settled', () => {
    const { container } = renderStrip(
      [task({ name: 'a' }), task({ name: 'b', state: 'running', exitCode: null }), task({ name: 'c' })],
      true,
    );

    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(2);
  });

  it('explains what pending actually means on hover', () => {
    renderStrip([task({ name: 'hub:init', state: 'pending', exitCode: null })], true);

    expect(screen.getAllByTitle(/did not run this bring-up/).length).toBeGreaterThan(0);
  });

  it('names the raw devenv task in every row tooltip', () => {
    renderStrip(roster(), true);

    for (const name of ['apps:init', 'hub:init', 'hub:migrate', 'sim:seed']) {
      expect(screen.getByTitle(new RegExp(`^${name} — `))).toBeTruthy();
    }
  });

  it('hangs the log tail off the failed row', () => {
    renderStrip([task({ state: 'failed', exitCode: 2, detail: 'psql: connection refused' })], true);

    expect(screen.getByTitle('psql: connection refused')).toBeTruthy();
  });

  it('hides the exit code for every state that has no exit status', () => {
    for (const state of ['pending', 'running', 'completed'] as const) {
      const { container } = renderStrip([task({ state })], true);
      expect(container.textContent).not.toMatch(/exit /);
      cleanup();
    }
  });

  it('renders an unmapped task under its raw colon-bearing name', () => {
    renderStrip([task({ name: 'future:task', label: 'future:task' })], true);

    expect(screen.getByText('future:task')).toBeTruthy();
  });

  it('marks the task whose log is open', () => {
    const { container } = render(
      <InitDagStrip tasks={roster()} activeName="hub:init" open onToggle={vi.fn()} onView={vi.fn()} />,
    );

    expect(container.querySelectorAll('.text-accent')).toHaveLength(1);
  });
});

describe('initFocusTask', () => {
  it('points at nothing while every task is inert', () => {
    expect(initFocusTask([task({ state: 'completed' }), task({ name: 'x', state: 'pending' })])).toBeUndefined();
  });

  it('points at a running task', () => {
    const running = task({ name: 'sim:seed', state: 'running' });

    expect(initFocusTask([task(), running])?.name).toBe('sim:seed');
  });

  it('prefers a failure over a task still running', () => {
    const failed = task({ name: 'hub:init', state: 'failed', exitCode: 1 });
    const running = task({ name: 'sim:seed', state: 'running' });

    expect(initFocusTask([running, failed])?.name).toBe('hub:init');
  });
});

describe('initAggregateState', () => {
  it('reads pending when nothing ran at all', () => {
    expect(initAggregateState([task({ state: 'pending' }), task({ name: 'x', state: 'pending' })])).toBe('pending');
  });

  it('reads completed once anything finished and nothing is outstanding', () => {
    expect(initAggregateState([task({ state: 'pending' }), task({ name: 'x', state: 'completed' })])).toBe('completed');
  });

  it('lets a failure outrank a completion', () => {
    expect(initAggregateState([task({ state: 'completed' }), task({ name: 'x', state: 'failed' })])).toBe('failed');
  });
});

describe('initSummary', () => {
  it('reports a whole-roster success as a bare count', () => {
    expect(initSummary([task({ name: 'a' }), task({ name: 'b' })])).toBe('2 completed');
  });

  it('shows an unknown exit code as a question mark rather than dropping it', () => {
    expect(initSummary([task({ state: 'failed', exitCode: null })])).toBe('hub:migrate failed exit ? · 0/1');
  });
});
