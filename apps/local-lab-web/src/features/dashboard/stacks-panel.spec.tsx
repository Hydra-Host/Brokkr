// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { RegisteredStack } from '@/contract';

import { StacksPanel } from './stacks-panel';

const stack = (over: Partial<RegisteredStack> = {}): RegisteredStack => ({
  slot: 0,
  checkout: '/work/boss',
  state: 'up',
  live: true,
  hubUrl: 'http://localhost:3000',
  webUrl: 'http://localhost:5173',
  labUrl: 'http://localhost:3002',
  labWebUrl: 'http://localhost:5175',
  processes: { running: 12, total: 14 },
  healthLine: null,
  ...over,
});

const slotOne = (over: Partial<RegisteredStack> = {}): RegisteredStack =>
  stack({
    slot: 1,
    checkout: '/work/boss-wt2',
    hubUrl: 'http://localhost:21100',
    webUrl: 'http://localhost:21003',
    labUrl: 'http://localhost:21002',
    labWebUrl: 'http://localhost:21005',
    ...over,
  });

afterEach(cleanup);

describe('StacksPanel', () => {
  it('names the slot and checkout of the only stack on the host', () => {
    render(<StacksPanel stacks={[stack()]} selfSlot={0} />);
    expect(screen.getByText('boss (this checkout)')).toBeTruthy();
    expect(screen.getByText('slot 0')).toBeTruthy();
  });

  it('says only one slot is claimed rather than implying a second stack', () => {
    render(<StacksPanel stacks={[stack()]} selfSlot={0} />);
    expect(screen.getByText('only this slot is claimed on this host')).toBeTruthy();
  });

  it('counts the claimed slots once a second one exists', () => {
    render(<StacksPanel stacks={[stack(), slotOne()]} selfSlot={0} />);
    expect(screen.getByText('2 claimed on this host')).toBeTruthy();
  });

  it('falls back to the serving slot when the registry lists nothing', () => {
    render(<StacksPanel stacks={[]} selfSlot={3} />);
    expect(screen.getByText(/slot 3 · this checkout/)).toBeTruthy();
  });

  it('renders nothing while the serving slot is unknown', () => {
    const { container } = render(<StacksPanel stacks={[]} selfSlot={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders each registered stack with its links once a second slot exists', () => {
    render(
      <StacksPanel
        stacks={[
          stack(),
          slotOne({ processes: { running: 9, total: 12 }, healthLine: 'pg up · redis up · fleet 1/1 on' }),
        ]}
        selfSlot={0}
      />,
    );
    expect(screen.getByText('boss-wt2')).toBeTruthy();
    expect(screen.getByText('boss (this checkout)')).toBeTruthy();
    expect(screen.getByText('slot 1')).toBeTruthy();
    expect(screen.getByText('pg up · redis up · fleet 1/1 on')).toBeTruthy();
  });

  it('links hub to the hub spa and lab to that stack control center', () => {
    render(<StacksPanel stacks={[stack(), slotOne()]} selfSlot={0} />);
    expect(screen.getAllByRole('link', { name: /hub/i }).map((a) => a.getAttribute('href'))).toEqual([
      'http://localhost:5173',
      'http://localhost:21003',
    ]);
    expect(screen.getAllByRole('link', { name: /lab/i }).map((a) => a.getAttribute('href'))).toEqual([
      'http://localhost:5175',
      'http://localhost:21005',
    ]);
    expect(screen.getAllByRole('link')).toHaveLength(4);
  });

  it('marks the stack whose slot matches selfSlot, not the first row', () => {
    render(<StacksPanel stacks={[stack(), slotOne()]} selfSlot={1} />);
    expect(screen.getByText('boss-wt2 (this checkout)')).toBeTruthy();
    expect(screen.getByText('boss')).toBeTruthy();
  });

  it('marks no row when the serving slot is unknown', () => {
    render(<StacksPanel stacks={[stack(), slotOne()]} selfSlot={null} />);
    expect(screen.queryByText(/\(this checkout\)/)).toBeNull();
  });

  it('falls back to the process rollup when a live stack has no health line', () => {
    render(
      <StacksPanel
        stacks={[stack(), slotOne({ healthLine: null, processes: { running: 9, total: 11 } })]}
        selfSlot={0}
      />,
    );
    expect(screen.getByText('9/11 processes')).toBeTruthy();
  });

  it('marks a not-live stack without probing', () => {
    render(
      <StacksPanel
        stacks={[
          stack(),
          stack({ slot: 2, checkout: '/work/boss-wt3', live: false, processes: { running: 0, total: 0 } }),
        ]}
        selfSlot={0}
      />,
    );
    expect(screen.getByText('not live')).toBeTruthy();
  });

  it('renders a disabled marker for a stack with no denormalized ports', () => {
    render(<StacksPanel stacks={[stack(), slotOne({ webUrl: null, labWebUrl: null })]} selfSlot={0} />);
    expect(screen.getAllByRole('link', { name: /hub/i })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: /lab/i })).toHaveLength(1);
  });
});
