import { describe, expect, it } from 'vitest';

import { buildPhoneHomeCreds, CloudInitPayloadError } from '../cloud-init-payload.js';

describe('buildPhoneHomeCreds', () => {
  it('fails loudly when server_token is missing', async () => {
    await expect(buildPhoneHomeCreds({ deviceId: 'dev-1', jobId: 'j', serverToken: null })).rejects.toThrowError(
      'server_token missing from saga payload for device dev-1 (hub must mint it before enqueuing the provision saga)',
    );
    await expect(buildPhoneHomeCreds({ deviceId: 'dev-1', jobId: 'j', serverToken: undefined })).rejects.toThrowError(
      CloudInitPayloadError,
    );
    await expect(buildPhoneHomeCreds({ deviceId: 'dev-1', jobId: 'j', serverToken: 'opaque' })).rejects.toThrowError(
      CloudInitPayloadError,
    );
  });

  it.each([
    ['missing token', { endpoint: 'https://hub/phone-home' }],
    ['missing endpoint', { deployment_os_token: 'test-os-token-abc' }],
    ['empty token', { deployment_os_token: '', endpoint: 'https://hub/phone-home' }],
    ['empty endpoint', { deployment_os_token: 'test-os-token-abc', endpoint: '' }],
    ['non-string token', { deployment_os_token: 42, endpoint: 'https://hub/phone-home' }],
    ['non-string endpoint', { deployment_os_token: 'test-os-token-abc', endpoint: 9 }],
  ])('fails loudly on malformed bundle: %s', async (_label, serverToken) => {
    await expect(buildPhoneHomeCreds({ deviceId: 'dev-2', jobId: 'j', serverToken })).rejects.toThrowError(
      "server_token for device dev-2 is malformed: expected non-empty 'deployment_os_token' and 'endpoint' strings",
    );
  });

  it('unpacks a well-formed hub-minted bundle', async () => {
    const creds = await buildPhoneHomeCreds({
      deviceId: 'dev-3',
      jobId: 'j',
      serverToken: {
        deployment_os_token: 'test-os-token-abc',
        endpoint: 'https://hub/phone-home',
        exp: 1_730_000_000,
      },
    });
    expect(creds).toEqual({ deployment_os_token: 'test-os-token-abc', endpoint: 'https://hub/phone-home' });
  });
});
