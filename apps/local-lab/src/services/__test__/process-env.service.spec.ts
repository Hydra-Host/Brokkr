import { ServiceUnavailableException } from '@nestjs/common';
import { vi } from 'vitest';

import type { ProcessComposeClient } from '../process-compose.client';
import { ProcessEnvService } from '../process-env.service';
import type { RenderedConfigService } from '../rendered-config.service';

describe('ProcessEnvService.getProcessEnv — config unavailable → 503', () => {
  it('throws ServiceUnavailableException when renderedConfigPath rejects', async () => {
    const pc = { list: vi.fn(async () => []) };
    const rendered = { renderedConfigPath: vi.fn().mockRejectedValue(new Error('stale snapshot')) };
    const svc = new ProcessEnvService(
      pc as unknown as ProcessComposeClient,
      rendered as unknown as RenderedConfigService,
    );

    const err = await svc.getProcessEnv('x', false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).message).toMatch(/rendered config unavailable/);
  });
});
