import { describe, expect, it } from 'vitest';

import type { ServerTokenAtomRequest } from '../phone-home.service.js';
import { createPhoneHomeService, PhoneHomeService } from '../phone-home.service.js';

describe('PhoneHomeService.getPhoneHomeVariables', () => {
  it('returns the bearer and endpoint dict on atom hit', async () => {
    const service = new PhoneHomeService('job-1', async () => ({
      brokkr_live_token: 'test-live-token-abc',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
      exp: 1_730_000_000,
    }));

    const result = await service.getPhoneHomeVariables('42');

    expect(result).toEqual({
      brokkr_live_token: 'test-live-token-abc',
      phone_home_endpoint: 'https://hub/api/v1/bmc/phone-home',
    });
  });

  it('uses the canonical device-server-token unprefixed atom_key form', async () => {
    const captured: ServerTokenAtomRequest[] = [];
    const service = new PhoneHomeService('job-3', async (params) => {
      captured.push(params);
      return { brokkr_live_token: 'test-live-token-abc', endpoint: 'https://hub/api/v1/bmc/phone-home', exp: 1 };
    });

    await service.getPhoneHomeVariables('7');

    expect(captured).toHaveLength(1);
    expect(captured[0]?.domain).toBe('server_token');
    expect(captured[0]?.entityId).toBe('7');
    expect(captured[0]?.atomKey).toBe('device:7:server_token');
  });
});

describe('createPhoneHomeService', () => {
  it('returns a PhoneHomeService instance bound to the supplied jobId', async () => {
    const service = await createPhoneHomeService('factory-job', async () => null);
    expect(service).toBeInstanceOf(PhoneHomeService);
    expect(service.jobId).toBe('factory-job');
  });
});
