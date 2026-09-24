import { ArgumentsHost, HttpStatus, Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GateUnavailableError } from 'src/plugin-host/host-plugin-gate-bus';
import { GateUnavailableErrorFilter } from '../gate-unavailable-error.filter';

function host(url = '/api/v1/devices/device-1/invite') {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const argsHost = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url, method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;
  return { argsHost, status, json };
}

describe('GateUnavailableErrorFilter', () => {
  const filter = new GateUnavailableErrorFilter();

  beforeAll(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('maps a circuit-open fail-closed gate to 503 without exposing the plugin id', () => {
    const { argsHost, status, json } = host();
    filter.catch(new GateUnavailableError('reservation.invite.authorize', 'commerce'), argsHost);
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 503,
        path: '/api/v1/devices/device-1/invite',
        message: 'Authorization is currently unavailable; try again shortly',
      }),
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('commerce'));
  });
});
