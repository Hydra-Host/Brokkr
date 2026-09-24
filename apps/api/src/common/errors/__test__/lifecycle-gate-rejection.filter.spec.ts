import { LifecycleGateRejection } from '@hydrahost/plugin-sdk';
import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { LifecycleGateRejectionFilter } from '../lifecycle-gate-rejection.filter';

function host(url = '/api/v1/inventory/device-1/provision') {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const argsHost = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url, method: 'PATCH' }),
    }),
  } as unknown as ArgumentsHost;
  return { argsHost, status, json };
}

describe('LifecycleGateRejectionFilter', () => {
  const filter = new LifecycleGateRejectionFilter();

  it('maps a gate veto to 400 with the gate reason as the client message', () => {
    const { argsHost, status, json } = host();
    filter.catch(new LifecycleGateRejection('Complete billing onboarding before provisioning from inventory'), argsHost);
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Complete billing onboarding before provisioning from inventory',
      }),
    );
  });

  it('maps a server-kind veto to 503 without turning it into a 500', () => {
    const { argsHost, status, json } = host();
    filter.catch(new LifecycleGateRejection('Billing is currently unavailable; try again shortly', 'server'), argsHost);
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 503,
        message: 'Billing is currently unavailable; try again shortly',
      }),
    );
  });
});
