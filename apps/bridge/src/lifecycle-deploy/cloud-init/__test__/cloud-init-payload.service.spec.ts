import { describe, expect, it } from 'vitest';

import type { ContextLogger } from '../../../logger/logger.service';
import { CloudInitPayloadError, CloudInitPayloadService } from '../cloud-init-payload.service';

const noopLogger = {
  info: async () => {},
  warning: async () => {},
  error: async () => {},
  debug: async () => {},
} as unknown as ContextLogger;

function newService(): CloudInitPayloadService {
  return new CloudInitPayloadService(noopLogger);
}

describe('CloudInitPayloadService.buildPhoneHomeCreds', () => {
  it('returns typed creds from a well-formed payload', async () => {
    const service = newService();
    const creds = await service.buildPhoneHomeCreds({
      deviceId: '42',
      jobId: 'job-x',
      serverToken: {
        deployment_os_token: 'test-os-token-abc',
        endpoint: 'https://hub/api/v1/bmc/phone-home',
      },
    });
    expect(creds).toEqual({
      deployment_os_token: 'test-os-token-abc',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
    });
  });

  it('uses the hub-supplied endpoint from the bundle', async () => {
    const service = newService();
    const creds = await service.buildPhoneHomeCreds({
      deviceId: 'dev-3',
      jobId: 'j',
      serverToken: {
        deployment_os_token: 'test-os-token-xyz',
        endpoint: 'https://hub/api/v1/bmc/phone-home',
        exp: 1_730_000_000,
      },
    });
    expect(creds).toEqual({
      deployment_os_token: 'test-os-token-xyz',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
    });
  });

  it('raises when the payload omits server_token', async () => {
    const service = newService();
    for (const token of [null, undefined, 'opaque', 42, []]) {
      await expect(
        service.buildPhoneHomeCreds({ deviceId: '42', jobId: 'job-x', serverToken: token }),
      ).rejects.toThrowError(CloudInitPayloadError);
      await expect(
        service.buildPhoneHomeCreds({ deviceId: '42', jobId: 'job-x', serverToken: token }),
      ).rejects.toThrowError(
        'server_token missing from saga payload for device 42 (hub must mint it before enqueuing the provision saga)',
      );
    }
  });

  it.each([
    ['missing token', { endpoint: 'https://hub/api/v1/bmc/phone-home' }],
    ['missing endpoint', { deployment_os_token: 'test-os-token-abc' }],
    ['empty token', { deployment_os_token: '', endpoint: 'https://hub/api/v1/bmc/phone-home' }],
    ['empty endpoint', { deployment_os_token: 'test-os-token-abc', endpoint: '' }],
    ['non-string token', { deployment_os_token: 123, endpoint: 'https://hub/api/v1/bmc/phone-home' }],
    ['non-string endpoint', { deployment_os_token: 'test-os-token-abc', endpoint: 9 }],
  ])('raises when the bundle is malformed: %s', async (_label, serverToken) => {
    const service = newService();
    await expect(service.buildPhoneHomeCreds({ deviceId: '42', jobId: 'job-x', serverToken })).rejects.toThrowError(
      "server_token for device 42 is malformed: expected non-empty 'deployment_os_token' and 'endpoint' strings",
    );
  });
});
