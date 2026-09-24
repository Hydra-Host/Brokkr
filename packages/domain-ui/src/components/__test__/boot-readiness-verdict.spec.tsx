import type { DeviceBootReadiness } from '@repo/api-client';
import { BOOT_CODES } from '@repo/utils';
import { cleanup, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeDiagnosticsApi, renderWithDiagnostics } from '../../test/diagnostics-harness';
import { BootReadinessVerdict } from '../boot-readiness-verdict';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

const DEVICE = '22222222-2222-2222-2222-222222222222';
const PREFIX = '33333333-3333-3333-3333-333333333333';

const readiness = (findings: DeviceBootReadiness['findings']): DeviceBootReadiness => ({
  deviceId: DEVICE,
  prefixId: PREFIX,
  prefixSelection: 'containing',
  pxeMac: '3c:ec:ef:1a:2b:3c',
  pxeInterface: null,
  pxeMacSource: null,
  bmcAddress: null,
  findings,
  evaluated: { hubPrefix: true, bootTrail: true, bootedWithoutDhcp: false },
  trail: { pxe: null, chainReached: false, chainAtMs: null, chainDeviceMismatch: false, readError: null },
});

afterEach(cleanup);

describe('BootReadinessVerdict', () => {
  it('renders nothing while the evaluation is pending', () => {
    const { container } = renderWithDiagnostics(
      <BootReadinessVerdict deviceId={DEVICE} />,
      fakeDiagnosticsApi({ bootReadiness: () => new Promise(() => {}) }),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the findings for the device', async () => {
    const bootReadiness = vi
      .fn()
      .mockResolvedValue(
        readiness([
          { code: 'PXE-104', severity: 'error', message: 'excluded', source: 'hub-prefix', prefixId: PREFIX },
        ]),
      );
    renderWithDiagnostics(<BootReadinessVerdict deviceId={DEVICE} />, fakeDiagnosticsApi({ bootReadiness }));

    expect(await screen.findByText(BOOT_CODES['PXE-104'].title)).toBeInTheDocument();
    expect(screen.getByText('Boot readiness')).toBeInTheDocument();
    expect(screen.getByText('Open prefix DHCP settings')).toHaveAttribute('href', `/prefixes/${PREFIX}/dhcp`);
    expect(bootReadiness).toHaveBeenCalledWith(DEVICE);
  });

  it('names the pxe interface and why it was chosen when the hub picked one', async () => {
    const withInterface: DeviceBootReadiness = {
      ...readiness([]),
      pxeInterface: 'ens4047f0np0',
      pxeMac: '80:61:5f:2c:59:ac',
      pxeMacSource: 'marker',
    };
    renderWithDiagnostics(
      <BootReadinessVerdict deviceId={DEVICE} />,
      fakeDiagnosticsApi({ bootReadiness: async () => withInterface }),
    );
    expect(
      await screen.findByText(
        /PXE interface: ens4047f0np0 · 80:61:5f:2c:59:ac \(chosen because the bridge recorded a boot for it\)\./,
      ),
    ).toBeInTheDocument();
  });

  it('shows the empty text when nothing blocks the boot', async () => {
    renderWithDiagnostics(
      <BootReadinessVerdict deviceId={DEVICE} />,
      fakeDiagnosticsApi({ bootReadiness: async () => readiness([]) }),
    );
    expect(await screen.findByText('No hub-side finding.')).toBeInTheDocument();
  });

  it('groups the prefix findings as not blocking after a boot without bridge dhcp', async () => {
    renderWithDiagnostics(
      <BootReadinessVerdict deviceId={DEVICE} />,
      fakeDiagnosticsApi({
        bootReadiness: async () => ({
          ...readiness([
            { code: 'PXE-104', severity: 'error', message: 'excluded', source: 'hub-prefix', prefixId: PREFIX },
            { code: 'PXE-111', severity: 'warn', message: 'silent', source: 'boot-trail', prefixId: null },
          ]),
          evaluated: { hubPrefix: true, bootTrail: true, bootedWithoutDhcp: true },
        }),
      }),
    );

    expect(await screen.findByText(/these did not block its last boot/)).toBeInTheDocument();
    expect(screen.getByText('PXE-104').className).toContain('text-text-muted');
    expect(screen.getByText('PXE-104').className).not.toContain('text-status-offline');
    expect(screen.getByText('PXE-111').className).toContain('text-status-warning');
  });

  it('explains a forbidden evaluation', async () => {
    renderWithDiagnostics(
      <BootReadinessVerdict deviceId={DEVICE} />,
      fakeDiagnosticsApi({ bootReadiness: () => Promise.reject({ status: 403, body: {} }) }),
    );
    expect(await screen.findByText(/need ipam:read/)).toBeInTheDocument();
  });

  it('reports any other failure plainly', async () => {
    renderWithDiagnostics(
      <BootReadinessVerdict deviceId={DEVICE} />,
      fakeDiagnosticsApi({ bootReadiness: () => Promise.reject(new Error('boom')) }),
    );
    expect(await screen.findByText('Readiness could not be evaluated.')).toBeInTheDocument();
  });
});
