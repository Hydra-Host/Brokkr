import { describe, expect, it, vi } from 'vitest';

import { HOSTS } from '../../ports';
import type { HttpJsonRead } from '../../status/http-probe.service';
import { BridgeStatusReader } from '../bridge-status.reader';

const okRead = (body: unknown): HttpJsonRead => ({ ok: true, statusCode: 200, body });
const failedRead = (detail: string): HttpJsonRead => ({ ok: false, statusCode: null, detail });

const readerFor = (answer: HttpJsonRead) => {
  const readJson = vi.fn(() => Promise.resolve(answer));
  return { reader: new BridgeStatusReader({ readJson }), readJson };
};

describe('BridgeStatusReader', () => {
  it('parses a status body without pxe_port_bound as null', async () => {
    const { reader } = readerFor(okRead({ dhcp_standby_health: { answering: true }, readiness_error_count: 2 }));

    expect(await reader.read(8000)).toEqual({ answering: true, pxePortBound: null, readinessErrorCount: 2 });
  });

  it('carries every field the bridge does send', async () => {
    const { reader } = readerFor(
      okRead({ dhcp_standby_health: { answering: false, pxe_port_bound: true }, readiness_error_count: 0 }),
    );

    expect(await reader.read(8000)).toEqual({ answering: false, pxePortBound: true, readinessErrorCount: 0 });
  });

  it('reads every field as null when the bridge sends no standby health block', async () => {
    const { reader } = readerFor(okRead({ dhcp_standby_health: null }));

    expect(await reader.read(8000)).toEqual({ answering: null, pxePortBound: null, readinessErrorCount: null });
  });

  it('reads the loopback status route on the given port through the shared probe', async () => {
    const { reader, readJson } = readerFor(okRead({}));

    await reader.read(8123);

    expect(readJson).toHaveBeenCalledWith(`http://${HOSTS.loopback}:8123/api/status`);
  });

  it('reads null when the probe reports a failure', async () => {
    const { reader } = readerFor(failedRead('ECONNREFUSED'));

    expect(await reader.read(8000)).toBeNull();
  });

  it('reads null when the body does not match the status shape', async () => {
    const { reader } = readerFor(okRead({ dhcp_standby_health: { answering: 'yes' } }));

    expect(await reader.read(8000)).toBeNull();
  });
});
