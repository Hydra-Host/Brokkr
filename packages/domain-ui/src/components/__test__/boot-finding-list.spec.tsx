import type { BootReadinessFinding } from '@repo/api-client';
import { BOOT_CODES } from '@repo/utils';
import { cleanup, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeDiagnosticsApi, renderWithDiagnostics } from '../../test/diagnostics-harness';
import { BootFindingList } from '../boot-finding-list';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

const PREFIX = '33333333-3333-3333-3333-333333333333';

const prefixFinding: BootReadinessFinding = {
  code: 'PXE-104',
  severity: 'error',
  message: 'Prefix 10.40.0.0/22 allows 3 MACs; 3c:ec:ef:1a:2b:3c is not one of them.',
  source: 'hub-prefix',
  prefixId: PREFIX,
};

const trailFinding: BootReadinessFinding = {
  code: 'PXE-111',
  severity: 'warn',
  message: 'No PXE request from 3c:ec:ef:1a:2b:3c since the boot was expected.',
  source: 'boot-trail',
  prefixId: null,
};

afterEach(cleanup);

function renderList(bootExpected: boolean | null, canOpenPrefix = true) {
  return renderWithDiagnostics(
    <BootFindingList
      findings={[prefixFinding, trailFinding]}
      bootExpected={bootExpected}
      canOpenPrefix={canOpenPrefix}
      emptyText="none"
    />,
  );
}

describe('BootFindingList', () => {
  it('renders the registry title and remedy with the prefix link from the api', () => {
    renderList(true);

    expect(screen.getByText(BOOT_CODES['PXE-104'].title)).toBeInTheDocument();
    expect(screen.getByText(BOOT_CODES['PXE-104'].remedy)).toBeInTheDocument();
    expect(screen.getByText('Open prefix DHCP settings')).toHaveAttribute('href', `/prefixes/${PREFIX}/dhcp`);
  });

  it('shows severity badges while a boot is expected', () => {
    renderList(true);

    expect(screen.getByText('PXE-104').className).toContain('text-status-offline');
    expect(screen.getByText('PXE-111').className).toContain('text-status-warning');
    expect(screen.getByText(BOOT_CODES['PXE-104'].title).closest('li')?.className).not.toContain(
      'text-muted-foreground',
    );
  });

  it('mutes the rows and keeps the code badge when no boot is expected', () => {
    renderList(false);

    const badge = screen.getByText('PXE-104');
    expect(badge.className).toContain('text-text-muted');
    expect(badge.className).not.toContain('text-status-offline');
    expect(screen.getByText('PXE-111').className).not.toContain('text-status-warning');
    expect(screen.getByText(BOOT_CODES['PXE-104'].title).closest('li')?.className).toContain('text-muted-foreground');
    expect(screen.getByText(prefixFinding.message)).toBeInTheDocument();
  });

  it('keeps the severity style when the expectation is unknown', () => {
    renderList(null);

    expect(screen.getByText('PXE-104').className).toContain('text-status-offline');
    expect(screen.getByText('PXE-111').className).toContain('text-status-warning');
  });

  it('renders the prefix link only with prefix access', () => {
    const { unmount } = renderList(true, false);
    expect(screen.queryByText('Open prefix DHCP settings')).not.toBeInTheDocument();
    unmount();

    renderList(true, true);
    expect(screen.getAllByText('Open prefix DHCP settings')).toHaveLength(1);
  });

  it('names the prefix as text when the api has no prefix page', () => {
    renderWithDiagnostics(
      <BootFindingList findings={[prefixFinding]} bootExpected canOpenPrefix emptyText="none" />,
      fakeDiagnosticsApi({ hrefs: { ...fakeDiagnosticsApi().hrefs, prefix: () => null } }),
    );

    expect(screen.queryByText('Open prefix DHCP settings')).not.toBeInTheDocument();
    expect(screen.getByText(`prefix ${PREFIX}`)).toBeInTheDocument();
  });

  it('shows the empty text when there is no finding', () => {
    renderWithDiagnostics(
      <BootFindingList findings={[]} bootExpected canOpenPrefix emptyText="No hub-side finding." />,
    );
    expect(screen.getByText('No hub-side finding.')).toBeInTheDocument();
  });
});
