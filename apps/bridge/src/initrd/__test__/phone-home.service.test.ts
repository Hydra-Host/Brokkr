import { describe, expect, it } from 'vitest';

import type { ServerTokenAtomRequest } from '../phone-home.service.js';
import { createPhoneHomeService, PhoneHomeCredsUnavailable, PhoneHomeService } from '../phone-home.service.js';

describe('PhoneHomeService', () => {
  it('returns the hub-supplied bearer and endpoint when the atom resolves', async () => {
    const requests: ServerTokenAtomRequest[] = [];
    const service = new PhoneHomeService('job-1', (params) => {
      requests.push(params);
      return Promise.resolve({
        brokkr_live_token: 'test-live-token-abc',
        endpoint: 'https://hub/api/v1/bmc/phone-home',
        exp: 1_730_000_000,
      });
    });

    const vars = await service.getPhoneHomeVariables('dev-1');

    expect(vars).toEqual({
      brokkr_live_token: 'test-live-token-abc',
      phone_home_endpoint: 'https://hub/api/v1/bmc/phone-home',
    });
    expect(requests).toEqual([
      { domain: 'server_token', entityId: 'dev-1', atomKey: 'device:dev-1:server_token', jobId: 'job-1' },
    ]);
  });

  it('raises PhoneHomeCredsUnavailable when the atom never resolves (timeout or negative cache)', async () => {
    const service = await createPhoneHomeService('job-1', () => Promise.resolve(null));

    await expect(service.getPhoneHomeVariables('dev-2')).rejects.toThrowError(PhoneHomeCredsUnavailable);
    await expect(service.getPhoneHomeVariables('dev-2')).rejects.toThrowError(
      'server_token atom unavailable for device dev-2 (hub render request timed out or returned negative-cache)',
    );
  });

  it('propagates fetcher failures unchanged', async () => {
    const service = new PhoneHomeService('job-1', () => Promise.reject(new Error('redis down')));
    await expect(service.getPhoneHomeVariables('dev-3')).rejects.toThrowError('redis down');
  });
});
