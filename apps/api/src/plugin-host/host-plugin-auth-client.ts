import { type PluginAuthClient, type PluginVerifyApiKeyResult } from '@hydrahost/plugin-sdk';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthClient } from '@repo/auth';

@Injectable()
export class HostPluginAuthClient implements PluginAuthClient {
  constructor(@Inject('AUTH_CLIENT') private readonly authClient: AuthClient) {}

  async verifyApiKey(key: string): Promise<PluginVerifyApiKeyResult> {
    const result = await this.authClient.api.verifyApiKey({ body: { key } });
    const verified = result.key;
    if (result.valid && !result.error && verified?.id && verified.referenceId) {
      return {
        valid: true,
        key: { id: verified.id, referenceId: verified.referenceId, name: verified.name ?? null },
      };
    }
    const rawError = result.error;
    return {
      valid: false,
      error: rawError
        ? {
            code: rawError.code,
            message: typeof rawError.message === 'string' ? rawError.message : undefined,
          }
        : null,
    };
  }
}
