// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { FleetStatus } from '@/contract';

import { AccelChip } from './accel-chip';

const fleet = (accel: FleetStatus['accel'], accelForced: FleetStatus['accelForced']) => ({ accel, accelForced });

afterEach(cleanup);

describe('AccelChip', () => {
  it('names the host as the cause when the accelerator was probed', () => {
    render(<AccelChip fleet={fleet('tcg', false)} />);
    expect(screen.getByText('emulated · no KVM')).toBeTruthy();
    expect(screen.getByText('emulated · no KVM').getAttribute('title')).toContain('KVM is not available');
  });

  it('names the setting as the cause when the accelerator was forced', () => {
    render(<AccelChip fleet={fleet('tcg', true)} />);
    expect(screen.getByText('emulated · forced')).toBeTruthy();
    expect(screen.getByText('emulated · forced').getAttribute('title')).toContain('LOCAL_ACCEL');
  });

  it('claims no cause when the engine recorded none', () => {
    render(<AccelChip fleet={fleet('tcg', null)} />);
    expect(screen.getByText('emulated')).toBeTruthy();
    expect(screen.queryByText(/no KVM|forced/)).toBeNull();
  });

  it('renders nothing under kvm', () => {
    const { container } = render(<AccelChip fleet={fleet('kvm', false)} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing under hvf', () => {
    const { container } = render(<AccelChip fleet={fleet('hvf', false)} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when no progress record carries an accelerator', () => {
    const { container } = render(<AccelChip fleet={fleet(null, null)} />);
    expect(container.innerHTML).toBe('');
  });
});
