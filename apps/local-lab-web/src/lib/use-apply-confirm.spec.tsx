// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApplyPlan } from '@/contract';

const { lab } = vi.hoisted(() => ({
  lab: { plan: undefined as { status: number; body: unknown } | undefined },
}));

vi.mock('@/lib/api', () => ({
  tsr: { getFleetApplyPlan: { useQuery: () => ({ refetch: () => Promise.resolve({ data: lab.plan }) }) } },
}));

import { ApplyConfirmProvider, useApplyConfirm, type ApplyConfirm } from './use-apply-confirm';

function plan(over: Partial<ApplyPlan> = {}): ApplyPlan {
  return {
    fallbackFullRebuild: false,
    reason: null,
    dataLoss: true,
    etaSec: 600,
    items: [
      {
        name: 'cpu-1',
        action: 'node-disk',
        reason: 'os disk grew',
        fields: ['disk_gb'],
        etaSec: 45,
        dataLoss: true,
      },
      { name: 'cpu-2', action: 'hot-node', reason: 'vcpu count changed', fields: ['cpus'], etaSec: 5, dataLoss: false },
    ],
    ...over,
  };
}

const results: ApplyConfirm[] = [];

function Harness() {
  const { confirmApply } = useApplyConfirm();
  return (
    <button
      onClick={() => {
        void confirmApply().then((r) => results.push(r));
      }}
    >
      apply
    </button>
  );
}

async function clickApply(body?: ApplyPlan): Promise<void> {
  lab.plan = body ? { status: 200, body } : undefined;
  render(
    <ApplyConfirmProvider>
      <Harness />
    </ApplyConfirmProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'apply' }));
  await screen.findByText('Confirm: Apply fleet changes');
}

beforeEach(() => {
  lab.plan = undefined;
  results.length = 0;
});

afterEach(cleanup);

describe('useApplyConfirm — the gate for a destructive plan', () => {
  it('names every node the apply touches', async () => {
    await clickApply(plan());

    expect(screen.getByText('cpu-1')).toBeTruthy();
    expect(screen.getByText('cpu-2')).toBeTruthy();
  });

  it('gives each node its own action and reason', async () => {
    await clickApply(plan());

    expect(screen.getByText('recreates disk')).toBeTruthy();
    expect(screen.getByText('os disk grew')).toBeTruthy();
    expect(screen.getByText('live update')).toBeTruthy();
    expect(screen.getByText('vcpu count changed')).toBeTruthy();
  });

  it('lists the fields that changed', async () => {
    await clickApply(plan());

    expect(screen.getByText('[disk_gb]')).toBeTruthy();
    expect(screen.getByText('[cpus]')).toBeTruthy();
  });

  it('shows a per-node eta beside the total', async () => {
    await clickApply(plan());

    expect(screen.getByText('~45s')).toBeTruthy();
    expect(screen.getByText('total ~10m')).toBeTruthy();
  });

  it('leads with the rebuild reason when identity shifted', async () => {
    await clickApply(plan({ fallbackFullRebuild: true, reason: 'node count changed' }));

    expect(screen.getByText('This change requires a full rebuild (node count changed). Continue?')).toBeTruthy();
  });

  it('authorizes data loss only once the operator continues', async () => {
    await clickApply(plan());

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await vi.waitFor(() => expect(results).toEqual([{ proceed: true, allowDataLoss: true }]));
  });

  it('withholds consent on cancel', async () => {
    await clickApply(plan());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await vi.waitFor(() => expect(results).toEqual([{ proceed: false, allowDataLoss: false }]));
  });

  it('falls back to the unverified-plan wording when the plan cannot be read', async () => {
    await clickApply();

    expect(screen.getByText(/Couldn't verify the apply plan/)).toBeTruthy();
  });
});

describe('useApplyConfirm — a plan that changes nothing destructive', () => {
  it('proceeds without a gate', async () => {
    lab.plan = { status: 200, body: plan({ dataLoss: false, items: [] }) };
    render(
      <ApplyConfirmProvider>
        <Harness />
      </ApplyConfirmProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'apply' }));

    await vi.waitFor(() => expect(results).toEqual([{ proceed: true, allowDataLoss: false }]));
    expect(screen.queryByText('Confirm: Apply fleet changes')).toBeNull();
  });
});
