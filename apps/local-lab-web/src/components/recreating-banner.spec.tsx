// @vitest-environment jsdom
import { RESTART_STALE_AFTER_LABEL } from '@repo/local-lab-contract';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { RestartBanner } from '@/lib/use-restart-state';

import { ConnectivityDot, RecreatingBanner } from './recreating-banner';

const banner = (over: Partial<RestartBanner> = {}): RestartBanner => ({
  variant: 'pending',
  reason: 'reinit (nuke + rebuild)',
  logPath: '/state/lab-restart.log',
  opId: 'reinit',
  ...over,
});

describe('RecreatingBanner', () => {
  afterEach(cleanup);

  it('renders nothing when there is no recreation to explain', () => {
    const { container } = render(<RecreatingBanner banner={null} />);

    expect(container.firstChild).toBeNull();
  });

  it('explains that panels are empty because the stack is being recreated', () => {
    render(<RecreatingBanner banner={banner()} />);

    expect(screen.getByText(/Stack is being recreated/)).toBeTruthy();
    expect(screen.getByText(/reinit \(nuke \+ rebuild\)/)).toBeTruthy();
    expect(screen.getByText('/state/lab-restart.log')).toBeTruthy();
  });

  it('offers no way to dismiss it, since the marker retires itself', () => {
    render(<RecreatingBanner banner={banner()} />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('drops the spinner and names the log once the recreation is wedged past its bound', () => {
    const { container } = render(<RecreatingBanner banner={banner({ variant: 'stale' })} />);

    expect(screen.getByText(new RegExp(`run past ${RESTART_STALE_AFTER_LABEL}`))).toBeTruthy();
    expect(screen.getByText('/state/lab-restart.log')).toBeTruthy();
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
  });

  it('reports a failure recorded while the control center was down, without a spinner', () => {
    const { container } = render(<RecreatingBanner banner={banner({ variant: 'failed' })} />);

    expect(screen.getByText(/recreation failed while the control center was down/)).toBeTruthy();
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
    expect(container.firstElementChild?.className).toContain('status-offline');
  });

  it('keeps the in-flight variant on the established warning palette', () => {
    const { container } = render(<RecreatingBanner banner={banner()} />);

    expect(container.firstElementChild?.className).toContain('border-status-warning/70');
    expect(container.firstElementChild?.className).toContain('bg-status-warning/20');
  });

  it('still renders when the marker was never read, so no log path is known', () => {
    render(<RecreatingBanner banner={{ variant: 'pending', opId: 'purge' }} />);

    expect(screen.getByText(/Stack is being recreated/)).toBeTruthy();
    expect(screen.getByText(/purge/)).toBeTruthy();
  });

  it('explains a bare api outage without any recreation copy', () => {
    const { container } = render(<RecreatingBanner banner={{ variant: 'unreachable' }} />);

    expect(screen.getByText(/Control-center API unreachable/)).toBeTruthy();
    expect(screen.queryByText(/recreation/)).toBeNull();
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
    expect(container.firstElementChild?.className).toContain('status-offline');
  });
});

describe('ConnectivityDot', () => {
  afterEach(cleanup);

  it('pulses green only while the api actually answers', () => {
    const { container } = render(<ConnectivityDot link="online" />);

    expect(container.firstElementChild?.className).toContain('bg-status-online');
    expect(container.firstElementChild?.className).toContain('animate-pulse');
  });

  it('goes solid offline when the api is unreachable', () => {
    const { container } = render(<ConnectivityDot link="offline" />);

    expect(container.firstElementChild?.className).toContain('bg-status-offline');
    expect(container.firstElementChild?.className).not.toContain('animate-pulse');
  });

  it('does not claim green before the first answer lands', () => {
    const { container } = render(<ConnectivityDot link="connecting" />);

    expect(container.firstElementChild?.className).not.toContain('bg-status-online');
  });
});
