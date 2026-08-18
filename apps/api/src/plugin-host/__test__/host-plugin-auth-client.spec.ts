import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { HostPluginAuthClient } from '../host-plugin-auth-client';

describe('HostPluginAuthClient', () => {
  async function makeClient(verifyApiKey: ReturnType<typeof vi.fn>) {
    const moduleRef = await Test.createTestingModule({
      providers: [HostPluginAuthClient, { provide: 'AUTH_CLIENT', useValue: { api: { verifyApiKey } } }],
    }).compile();
    return { client: moduleRef.get(HostPluginAuthClient), moduleRef };
  }

  it('returns a verified key and drops Better Auth transport shape', async () => {
    const verifyApiKey = vi.fn().mockResolvedValue({
      valid: true,
      error: null,
      key: { id: 'ak-1', referenceId: 'user-1', name: 'grafana' },
    });
    const { client, moduleRef } = await makeClient(verifyApiKey);

    await expect(client.verifyApiKey('raw-key')).resolves.toEqual({
      valid: true,
      key: { id: 'ak-1', referenceId: 'user-1', name: 'grafana' },
    });
    expect(verifyApiKey).toHaveBeenCalledWith({ body: { key: 'raw-key' } });
    await moduleRef.close();
  });

  it('treats valid:true with a null key as invalid', async () => {
    const verifyApiKey = vi.fn().mockResolvedValue({ valid: true, error: null, key: null });
    const { client, moduleRef } = await makeClient(verifyApiKey);

    await expect(client.verifyApiKey('raw-key')).resolves.toEqual({ valid: false, error: null });
    await moduleRef.close();
  });

  it('forwards rate-limit errors', async () => {
    const verifyApiKey = vi.fn().mockResolvedValue({
      valid: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      key: null,
    });
    const { client, moduleRef } = await makeClient(verifyApiKey);

    await expect(client.verifyApiKey('raw-key')).resolves.toEqual({
      valid: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
    await moduleRef.close();
  });
});
