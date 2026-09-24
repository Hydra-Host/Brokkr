import type { DeviceBootReadiness, DeviceBootTrail } from '@repo/api-client';
import { BOOT_CODES } from '@repo/utils';
import { cleanup, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeDiagnosticsApi, renderWithDiagnostics } from '../../test/diagnostics-harness';
import { BootDiagnostics } from '../boot-diagnostics';
import type { DiagnosticDevice } from '../diagnostic-header-lines';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

const DEVICE = '22222222-2222-2222-2222-222222222222';
const ZONE = '11111111-1111-1111-1111-111111111111';
const PREFIX = '33333333-3333-3333-3333-333333333333';
const MAC = '3c:ec:ef:1a:2b:3c';

const device: DiagnosticDevice = {
  id: DEVICE,
  displayName: 'gpu-node-07',
  zoneId: ZONE,
  zoneName: 'ams-1',
  bmcIp: null,
  deployedOs: false,
  status: 'Provisioning',
};

const trail = (over: Partial<DeviceBootTrail> = {}): DeviceBootTrail => ({
  deviceId: DEVICE,
  pxeMac: MAC,
  pxeInterface: 'eth0',
  pxeMacSource: 'address',
  candidateMacs: ['3c:ec:ef:1a:2b:3d'],
  zoneId: ZONE,
  trail: {
    pxe: { outcome: 'offered', atMs: 1789560131000 },
    chainReached: true,
    chainAtMs: 1789560139000,
    chainDeviceMismatch: false,
    readError: null,
  },
  bootExpected: { expected: true, since: '2026-09-16T11:00:00.000Z', reason: 'active-job' },
  readAt: '2026-09-16T12:00:00.000Z',
  ...over,
});

const readiness = (over: Partial<DeviceBootReadiness> = {}): DeviceBootReadiness => ({
  deviceId: DEVICE,
  prefixId: PREFIX,
  prefixSelection: 'containing',
  pxeMac: MAC,
  pxeInterface: 'eth0',
  pxeMacSource: 'address',
  bmcAddress: null,
  findings: [{ code: 'PXE-104', severity: 'error', message: 'excluded', source: 'hub-prefix', prefixId: PREFIX }],
  evaluated: { hubPrefix: true, bootTrail: true, bootedWithoutDhcp: false },
  trail: trail().trail,
  ...over,
});

afterEach(cleanup);

describe('BootDiagnostics', () => {
  it('renders the trail and the readiness findings for the device', async () => {
    const bootTrail = vi.fn().mockResolvedValue(trail());
    const bootReadiness = vi.fn().mockResolvedValue(readiness());
    renderWithDiagnostics(<BootDiagnostics device={device} />, fakeDiagnosticsApi({ bootTrail, bootReadiness }));

    expect(await screen.findByText(/^boot trail\s*$/)).toBeInTheDocument();
    expect(screen.getByText(/recorded for gpu-node-07/)).toBeInTheDocument();
    expect(screen.getByText(/Boot expected since/)).toBeInTheDocument();
    expect(screen.getByText(MAC)).toBeInTheDocument();
    expect(screen.getByText(/eth0/)).toBeInTheDocument();
    expect(screen.getByText(/holds an IP address/)).toBeInTheDocument();
    expect(screen.getByText('3c:ec:ef:1a:2b:3d')).toBeInTheDocument();
    expect(screen.getByText(`Read from zone ${ZONE} by exact key.`)).toBeInTheDocument();
    expect(await screen.findByText(BOOT_CODES['PXE-104'].title)).toBeInTheDocument();
    expect(screen.getByText('Open prefix DHCP settings')).toHaveAttribute('href', `/prefixes/${PREFIX}/dhcp`);
    expect(screen.getByText(/Evaluated: hub prefix checks \(containing prefix\)/)).toBeInTheDocument();
    expect(bootTrail).toHaveBeenCalledWith(DEVICE);
    expect(bootReadiness).toHaveBeenCalledWith(DEVICE);
  });

  it('names the pxe interface the bridge recorded a boot for', async () => {
    renderWithDiagnostics(
      <BootDiagnostics device={device} />,
      fakeDiagnosticsApi({
        bootTrail: async () =>
          trail({ pxeInterface: 'ens4047f0np0', pxeMac: '80:61:5f:2c:59:ac', pxeMacSource: 'marker' }),
        bootReadiness: async () => readiness(),
      }),
    );
    expect(await screen.findByText(/ens4047f0np0/)).toBeInTheDocument();
    expect(screen.getByText('80:61:5f:2c:59:ac')).toBeInTheDocument();
    expect(screen.getByText(/recorded a boot/)).toBeInTheDocument();
  });

  it('says the interface was chosen by name when it has no address and no recorded boot', async () => {
    renderWithDiagnostics(
      <BootDiagnostics device={device} />,
      fakeDiagnosticsApi({
        bootTrail: async () => trail({ pxeMacSource: 'name-order' }),
        bootReadiness: async () => readiness(),
      }),
    );
    expect(await screen.findByText(/no address and no boot recorded/)).toBeInTheDocument();
  });

  it('flags a chain hit the bridge matched to another device', async () => {
    renderWithDiagnostics(
      <BootDiagnostics device={device} />,
      fakeDiagnosticsApi({
        bootTrail: async () => trail({ trail: { ...trail().trail, chainDeviceMismatch: true } }),
        bootReadiness: async () => readiness(),
      }),
    );
    expect(await screen.findByText('The bridge matched this MAC to another device.')).toBeInTheDocument();
  });

  it('mutes the findings when no boot is expected', async () => {
    renderWithDiagnostics(
      <BootDiagnostics device={device} />,
      fakeDiagnosticsApi({
        bootTrail: async () => trail({ bootExpected: { expected: false, since: null, reason: 'none' } }),
        bootReadiness: async () => readiness(),
      }),
    );
    expect(await screen.findByText(/These findings would block the next network boot/)).toBeInTheDocument();
    expect(screen.getByText(/No network boot is expected now, so a missing PXE request/)).toBeInTheDocument();
    expect(screen.getByText(BOOT_CODES['PXE-104'].title).closest('li')?.className).toContain('text-muted-foreground');
  });

  it('reports a trail that could not be loaded and a forbidden readiness separately', async () => {
    renderWithDiagnostics(
      <BootDiagnostics device={device} />,
      fakeDiagnosticsApi({
        bootTrail: () => Promise.reject(new Error('boom')),
        bootReadiness: () => Promise.reject({ status: 403, body: {} }),
      }),
    );
    expect(await screen.findByText('The boot trail could not be loaded.')).toBeInTheDocument();
    expect(await screen.findByText(/the boot trail still reads/)).toBeInTheDocument();
    expect(screen.queryByText(/Evaluated:/)).not.toBeInTheDocument();
  });

  it('says when the trail was unreadable and the prefix was not evaluated', async () => {
    renderWithDiagnostics(
      <BootDiagnostics device={device} />,
      fakeDiagnosticsApi({
        bootTrail: async () => trail({ zoneId: null }),
        bootReadiness: async () =>
          readiness({
            prefixId: null,
            prefixSelection: 'none',
            findings: [],
            evaluated: { hubPrefix: false, bootTrail: false, bootedWithoutDhcp: false },
          }),
      }),
    );
    expect(await screen.findByText('The device has no zone, so no bridge Redis was read.')).toBeInTheDocument();
    expect(await screen.findByText(/hub prefix checks not evaluated · boot trail unreadable/)).toBeInTheDocument();
    expect(screen.getByText(/No hub-side finding\./)).toBeInTheDocument();
  });
});
