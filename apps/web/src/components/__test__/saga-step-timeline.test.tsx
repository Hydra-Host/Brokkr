import type { LifecycleJobEvent } from '@repo/api-client';
import { SagaStepTimeline } from '@repo/domain-ui/components/saga-step-timeline';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 16, 12, 0, seconds)).toISOString();

let nextId = 0;
const event = (over: Partial<LifecycleJobEvent> = {}): LifecycleJobEvent => ({
  id: `e-${(nextId += 1)}`,
  sagaName: 'provision',
  stepName: 'set_boot_order',
  operation: null,
  eventType: 'stage_changed',
  status: 'complete',
  result: null,
  error: null,
  attempt: 0,
  occurredAt: at(0),
  recordedAt: at(0),
  origin: 'bridge',
  ...over,
});

const stepPair = (stepName: string, second: number) => [
  event({ stepName, status: 'running', occurredAt: at(second), recordedAt: at(second) }),
  event({ stepName, status: 'complete', occurredAt: at(second + 1), recordedAt: at(second + 1) }),
];

const hubRow = (over: Partial<LifecycleJobEvent> = {}) =>
  event({ sagaName: 'phone_home', stepName: 'phone_home', eventType: 'phone_home', origin: 'hub', ...over });

const liveProvision = () => [
  ...Array.from({ length: 25 }, (_, i) => stepPair(`step_${i + 1}`, i * 2)).flat(),
  event({ stepName: '(saga)', eventType: 'job_completed', occurredAt: at(50), recordedAt: at(50) }),
  hubRow({ occurredAt: at(55), recordedAt: at(55) }),
];

function renderTimeline(events: LifecycleJobEvent[], truncated = false) {
  return render(<SagaStepTimeline events={events} truncated={truncated} cap={500} />);
}

describe('SagaStepTimeline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders one row per folded step with the run header and footer', () => {
    renderTimeline(liveProvision());
    expect(screen.getAllByRole('listitem')).toHaveLength(26);
    expect(screen.getByText('provision · 25 steps')).toBeInTheDocument();
    expect(screen.getByText(/^saga complete at /)).toBeInTheDocument();
    expect(screen.getAllByText('1.0 s')).toHaveLength(25);
  });

  it('renders no toggle for steps without a result, an error or a skew note', () => {
    renderTimeline(liveProvision());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows an in-flight step running with no footer', () => {
    vi.useFakeTimers({ now: new Date(at(12)) });
    renderTimeline([event({ stepName: 'install_os', status: 'running' })]);
    expect(screen.getByText('running for 12 s')).toBeInTheDocument();
    expect(screen.queryByText(/^saga /)).not.toBeInTheDocument();
  });

  it('badges retries and hub rows and notes a large skew behind the toggle', () => {
    renderTimeline([
      event({ stepName: 'power_cycle', status: 'failed', error: 'ipmi timeout', recordedAt: at(7) }),
      event({ stepName: 'power_cycle', attempt: 1, occurredAt: at(8), recordedAt: at(8) }),
      hubRow({ occurredAt: at(9), recordedAt: at(20) }),
    ]);
    expect(screen.getByText('attempt 2')).toBeInTheDocument();
    expect(screen.getByText('hub')).toBeInTheDocument();
    expect(screen.queryByText('ipmi timeout')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText('ipmi timeout')).toHaveClass('text-destructive');
    expect(screen.getAllByText(/^skew /).map((el) => el.textContent)).toEqual(['skew 7.0 s']);
  });

  it('toggles a step detail from its row', () => {
    renderTimeline([event({ stepName: 'collect', result: { disks: 2 } })]);
    const row = screen.getByRole('button', { name: /collect/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/"disks": 2/)).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/"disks": 2/)).toBeInTheDocument();
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/"disks": 2/)).not.toBeInTheDocument();
  });

  it('expands and collapses every detailed step from the run header', () => {
    renderTimeline([
      event({ stepName: 'collect', result: { disks: 2 } }),
      event({ stepName: 'set_boot_order' }),
      event({ stepName: 'power_on', status: 'failed', error: 'no power' }),
    ]);
    const toggle = screen.getByRole('button', { name: 'Expand all' });
    fireEvent.click(toggle);
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(2);
    expect(screen.getByText('no power')).toBeInTheDocument();
    expect(toggle).toHaveTextContent('Collapse all');
    fireEvent.click(toggle);
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0);
    expect(screen.queryByText('no power')).not.toBeInTheDocument();
  });

  it('reports a failed saga in the footer', () => {
    renderTimeline([
      event({ stepName: 'install_os', status: 'failed', error: 'disk not found' }),
      event({ stepName: '(saga)', eventType: 'job_completed', status: 'failed', error: 'disk not found' }),
    ]);
    expect(screen.getByText('saga failed: disk not found')).toHaveClass('text-destructive');
  });

  it('omits the run ordinal with one run', () => {
    renderTimeline([event({ stepName: 'install_os' })]);
    expect(screen.getByText('provision · 1 step')).toBeInTheDocument();
    expect(screen.queryByText(/run 1 of/)).not.toBeInTheDocument();
  });

  it('numbers the runs when there are two', () => {
    renderTimeline([event({ stepName: 'install_os' }), event({ sagaName: 'power_on', stepName: 'power_on' })]);
    expect(screen.getByText('provision · 1 step · run 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('power_on · 1 step · run 2 of 2')).toBeInTheDocument();
  });

  it('notes truncation', () => {
    renderTimeline([event()], true);
    expect(screen.getByText('Showing the first 500 events; newer events are omitted.')).toBeInTheDocument();
  });

  it('shows the step label ahead of the raw name and the raw name alone without one', () => {
    renderTimeline([
      event({ operation: 'Set the boot order' }),
      event({ stepName: 'power_cycle', occurredAt: at(1), recordedAt: at(1) }),
    ]);
    const labeled = screen.getByText('set_boot_order');
    expect(labeled).toHaveClass('font-mono');
    expect(labeled.previousElementSibling).toHaveTextContent('Set the boot order');
    const unlabeled = screen.getByText('power_cycle');
    expect(unlabeled).toHaveClass('font-mono');
    expect(unlabeled.previousElementSibling).toBeNull();
  });
});
