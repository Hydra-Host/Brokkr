// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QueueCounts, QueueSummary } from '@/contract';

import { QueueTable } from './queue-table';

const ZERO: QueueCounts = {
  wait: 0,
  active: 0,
  paused: 0,
  delayed: 0,
  prioritized: 0,
  'waiting-children': 0,
  completed: 0,
  failed: 0,
};

function queue(overrides: Partial<QueueSummary> = {}): QueueSummary {
  return {
    prefix: 'zone-a',
    name: 'lifecycle',
    kind: 'saga',
    counts: { ...ZERO },
    stalled: 0,
    paused: false,
    workers: 0,
    inFlight: 0,
    readError: null,
    ...overrides,
  };
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

afterEach(cleanup);

describe('QueueTable', () => {
  it('renders an unreadable queue distinctly from an empty one', () => {
    render(
      <QueueTable
        queues={[queue({ name: 'empty-q' }), queue({ name: 'wedged-q', readError: 'ECONNREFUSED 127.0.0.1:6379' })]}
        selected={null}
        onSelect={vi.fn()}
        placeholder="none"
      />,
    );

    const wedged = rowOf('wedged-q');
    expect(wedged.textContent).toContain('unreadable');
    expect(wedged.textContent).toContain('ECONNREFUSED 127.0.0.1:6379');
    expect(wedged.textContent).toContain('this row is not an empty queue');
    expect(wedged.className).toContain('bg-status-offline/10');

    const empty = rowOf('empty-q');
    expect(empty.textContent).not.toContain('unreadable');
    expect(empty.className).not.toContain('bg-status-offline/10');
  });

  it('renders no counts at all on an unreadable row so a placeholder zero cannot be read as a measurement', () => {
    render(
      <QueueTable
        queues={[queue({ name: 'wedged-q', readError: 'read timed out' })]}
        selected={null}
        onSelect={vi.fn()}
        placeholder="none"
      />,
    );
    expect(screen.queryAllByText('0')).toHaveLength(0);
  });

  it('renders a measured zero on a queue that read cleanly and simply holds nothing', () => {
    render(<QueueTable queues={[queue({ name: 'empty-q' })]} selected={null} onSelect={vi.fn()} placeholder="none" />);
    expect(screen.queryAllByText('0').length).toBeGreaterThan(0);
    expect(screen.queryByText(/unreadable/)).toBeNull();
  });

  it('tones a non-zero failed count as a failure and a non-zero delayed count as in-flight', () => {
    render(
      <QueueTable
        queues={[queue({ counts: { ...ZERO, failed: 3, delayed: 5 } })]}
        selected={null}
        onSelect={vi.fn()}
        placeholder="none"
      />,
    );
    expect(screen.getByText('3').className).toContain('status-offline');
    expect(screen.getByText('5').className).not.toContain('status-offline');
  });

  it('selects the row the caller clicks', () => {
    const onSelect = vi.fn();
    render(
      <QueueTable queues={[queue({ name: 'lifecycle' })]} selected={null} onSelect={onSelect} placeholder="none" />,
    );
    fireEvent.click(rowOf('lifecycle'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'lifecycle' }));
  });

  it('marks the selected queue and flags a paused one', () => {
    render(
      <QueueTable
        queues={[queue({ name: 'lifecycle', paused: true })]}
        selected={{ prefix: 'zone-a', name: 'lifecycle' }}
        onSelect={vi.fn()}
        placeholder="none"
      />,
    );
    const row = rowOf('lifecycle');
    expect(row.className).toContain('bg-accent/10');
    expect(row.textContent).toContain('paused');
  });

  it('marks an undetermined worker count apart from a measured zero', () => {
    render(
      <QueueTable
        queues={[queue({ name: 'probed-q', workers: null }), queue({ name: 'idle-q', workers: 0 })]}
        selected={null}
        onSelect={vi.fn()}
        placeholder="none"
      />,
    );

    const probed = rowOf('probed-q');
    const marker = screen.getByTitle(/worker probe failed/);
    expect(marker.textContent).toBe('?');
    expect(probed.contains(marker)).toBe(true);

    const cellsOf = (row: HTMLElement) => [...row.querySelectorAll('td')].map((td) => td.textContent);
    expect(cellsOf(probed).at(-1)).toBe('?');
    expect(cellsOf(rowOf('idle-q')).at(-1)).toBe('0');
  });

  it('keeps a probe-failed row readable as a measurement rather than an unreadable one', () => {
    render(
      <QueueTable
        queues={[queue({ name: 'probed-q', workers: null, counts: { ...ZERO, failed: 7 } })]}
        selected={null}
        onSelect={vi.fn()}
        placeholder="none"
      />,
    );

    const probed = rowOf('probed-q');
    expect(probed.textContent).toContain('7');
    expect(probed.textContent).not.toContain('unreadable');
    expect(probed.className).not.toContain('bg-status-offline/10');
  });

  it('distinguishes an undetermined pause state from a queue known not to be paused', () => {
    render(
      <QueueTable
        queues={[queue({ name: 'probed-q', paused: null }), queue({ name: 'running-q', paused: false })]}
        selected={null}
        onSelect={vi.fn()}
        placeholder="none"
      />,
    );

    expect(rowOf('probed-q').textContent).toContain('paused?');
    expect(screen.getByTitle(/pause probe failed/)).toBeDefined();
    expect(rowOf('running-q').textContent).not.toContain('paused');
  });

  it('shows the placeholder instead of an empty table', () => {
    render(<QueueTable queues={[]} selected={null} onSelect={vi.fn()} placeholder="no queues discovered" />);
    expect(screen.getByText('no queues discovered')).toBeDefined();
  });
});
