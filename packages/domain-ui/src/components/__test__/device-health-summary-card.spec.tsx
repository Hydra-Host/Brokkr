import type { DeviceHealthSummary } from '@repo/api-client';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DeviceHealthSummaryCard } from '../device-health-summary-card';

const DORMANT_TITLE = 'not expected while the deployed OS runs';

const summary = (checks: Partial<NonNullable<DeviceHealthSummary['checks']>> = {}): DeviceHealthSummary => ({
  view: 'owner',
  source: 'snapshot',
  checkedAt: '2026-09-17T12:00:00.000Z',
  checks: {
    primaryReachable: true,
    bmcIcmpReachable: true,
    bmcIpmiReachable: true,
    bmcRedfishReachable: true,
    bmcCredsValid: true,
    poweredOn: true,
    brokkrLiveRunning: false,
    reachability: 'ok',
    ...checks,
  },
  isHealthy: true,
  reason: null,
  icmpFiltered: false,
});

function renderCard(deployedOs: boolean, checks?: Partial<NonNullable<DeviceHealthSummary['checks']>>) {
  return render(
    <DeviceHealthSummaryCard summary={summary(checks)} line="Last checked just now." deployedOs={deployedOs} />,
  );
}

afterEach(cleanup);

describe('DeviceHealthSummaryCard', () => {
  it('labels the discovery agent probe as the discovery OS and fails it before the deployed OS runs', () => {
    renderCard(false);

    expect(screen.getByText('discovery OS')).toBeInTheDocument();
    expect(screen.getByLabelText('discovery OS: failed')).toBeInTheDocument();
    expect(screen.queryByTitle(DORMANT_TITLE)).not.toBeInTheDocument();
  });

  it('shows a neutral dash for the discovery OS while the deployed OS runs', () => {
    renderCard(true);

    expect(screen.getByTitle(DORMANT_TITLE)).toBeInTheDocument();
    expect(screen.getByLabelText(`discovery OS: ${DORMANT_TITLE}`)).toBeInTheDocument();
    expect(screen.queryByLabelText('discovery OS: failed')).not.toBeInTheDocument();
  });

  it('keeps a passing discovery OS probe visible on a provisioned device', () => {
    renderCard(true, { brokkrLiveRunning: true });

    expect(screen.getByLabelText('discovery OS: passed')).toBeInTheDocument();
    expect(screen.queryByTitle(DORMANT_TITLE)).not.toBeInTheDocument();
  });

  it('mutes only the discovery OS probe while the deployed OS runs', () => {
    renderCard(true, { poweredOn: false, bmcIpmiReachable: null });

    expect(screen.getByLabelText('power: failed')).toBeInTheDocument();
    expect(screen.getByLabelText('ipmi: not tested')).toBeInTheDocument();
    expect(screen.getAllByTitle(DORMANT_TITLE)).toHaveLength(1);
  });
});
