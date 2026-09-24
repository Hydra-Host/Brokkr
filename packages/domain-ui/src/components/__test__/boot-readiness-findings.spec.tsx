import type { BootReadinessFinding, DeviceBootReadiness } from '@repo/api-client';
import { cleanup, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithDiagnostics } from '../../test/diagnostics-harness';
import { BootReadinessFindings, partitionReadinessFindings } from '../boot-readiness-findings';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

const DEVICE = '22222222-2222-2222-2222-222222222222';
const PREFIX = '33333333-3333-3333-3333-333333333333';
const NOTE = "This machine reached iPXE without the bridge's DHCP; these did not block its last boot.";
const NEXT_BOOT = /These findings would block the next network boot/;
const EMPTY = 'No hub-side finding.';

const excluded: BootReadinessFinding = {
  code: 'PXE-104',
  severity: 'error',
  message: 'Prefix 10.40.0.0/22 allows 3 MACs; 3c:ec:ef:1a:2b:3c is not one of them.',
  source: 'hub-prefix',
  prefixId: PREFIX,
};

const unevaluated: BootReadinessFinding = {
  code: 'PXE-107',
  severity: 'warn',
  message: 'No prefix contains the data address and the zone has no PRIMARY prefix.',
  source: 'hub-prefix',
  prefixId: null,
};

const silent: BootReadinessFinding = {
  code: 'PXE-111',
  severity: 'warn',
  message: 'No PXE request from 3c:ec:ef:1a:2b:3c since the boot was expected.',
  source: 'boot-trail',
  prefixId: null,
};

const readiness = (bootedWithoutDhcp: boolean, findings: BootReadinessFinding[]): DeviceBootReadiness => ({
  deviceId: DEVICE,
  prefixId: PREFIX,
  prefixSelection: 'primary',
  pxeMac: null,
  pxeInterface: null,
  pxeMacSource: null,
  bmcAddress: null,
  findings,
  evaluated: { hubPrefix: true, bootTrail: true, bootedWithoutDhcp },
  trail: { pxe: null, chainReached: true, chainAtMs: null, chainDeviceMismatch: false, readError: null },
});

function renderFindings(bootExpected: boolean | null, bootedWithoutDhcp: boolean, findings: BootReadinessFinding[]) {
  return renderWithDiagnostics(
    <BootReadinessFindings
      readiness={readiness(bootedWithoutDhcp, findings)}
      error={null}
      bootExpected={bootExpected}
      emptyText={EMPTY}
      forbiddenText="forbidden"
    />,
  );
}

afterEach(cleanup);

describe('partitionReadinessFindings', () => {
  it('keeps every finding blocking while the last boot went through the bridge', () => {
    expect(partitionReadinessFindings([excluded, unevaluated, silent], false)).toEqual({
      blocking: [excluded, unevaluated, silent],
      notBlocking: [],
    });
  });

  it('moves the hub prefix findings out of the blocking set after a boot without bridge dhcp', () => {
    expect(partitionReadinessFindings([excluded, unevaluated, silent], true)).toEqual({
      blocking: [silent],
      notBlocking: [excluded, unevaluated],
    });
  });

  it('leaves nothing to group when there is no finding', () => {
    expect(partitionReadinessFindings([], true)).toEqual({ blocking: [], notBlocking: [] });
  });
});

describe('BootReadinessFindings', () => {
  it('groups the prefix findings as not blocking after a boot without bridge dhcp while a boot is expected', () => {
    renderFindings(true, true, [excluded, silent]);

    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(screen.getByText('PXE-104').className).toContain('text-text-muted');
    expect(screen.getByText('PXE-104').className).not.toContain('text-status-offline');
    expect(screen.getByText('PXE-111').className).toContain('text-status-warning');
    expect(screen.queryByText(NEXT_BOOT)).not.toBeInTheDocument();
  });

  it('keeps the prefix findings blocking while the last boot went through the bridge', () => {
    renderFindings(true, false, [excluded, silent]);

    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    expect(screen.getByText('PXE-104').className).toContain('text-status-offline');
    expect(screen.getByText('PXE-111').className).toContain('text-status-warning');
  });

  it('shows only the not blocking group when every finding is prefix scoped', () => {
    renderFindings(true, true, [excluded]);

    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
    expect(screen.getByText('PXE-104').className).toContain('text-text-muted');
  });

  it('does not warn about the next boot when only not blocking findings remain', () => {
    renderFindings(false, true, [excluded]);

    expect(screen.queryByText(NEXT_BOOT)).not.toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it('warns about the next boot for blocking findings when no boot is expected', () => {
    renderFindings(false, false, [excluded]);

    expect(screen.getByText(NEXT_BOOT)).toBeInTheDocument();
    expect(screen.getByText('PXE-104').className).toContain('text-text-muted');
  });

  it('shows the empty text when there is no finding at all', () => {
    renderFindings(true, true, []);

    expect(screen.getByText(EMPTY)).toBeInTheDocument();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });
});
