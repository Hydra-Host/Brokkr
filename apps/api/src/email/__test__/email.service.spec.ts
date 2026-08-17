import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EMAIL_SENDER, type EmailSender } from '../email-sender';
import { EmailService } from '../email.service';

type Env = Record<string, string | undefined>;

const send = vi.fn();

async function buildService(
  env: Env,
  senderEnabled = true,
): Promise<{ service: EmailService; logger: Record<string, ReturnType<typeof vi.fn>> }> {
  const mockConfigService = { get: vi.fn((key: string) => env[key]) };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const sender: EmailSender = { enabled: senderEnabled, send };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      EmailService,
      { provide: ConfigService, useValue: mockConfigService },
      { provide: EMAIL_SENDER, useValue: sender },
      { provide: `LoggerService${EmailService.name}`, useValue: logger },
    ],
  }).compile();

  const service = module.get(EmailService);
  await module.init();
  return { service, logger };
}

const reset = (service: EmailService) =>
  service.send.passwordReset({ email: 'a@example.com', firstName: 'A', url: 'https://x' });

describe('EmailService transport gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('warns at boot when the transport is disabled (non-local)', async () => {
    const { logger } = await buildService({ IS_LOCAL: 'false' }, false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not warn at boot when running locally', async () => {
    const { logger } = await buildService({ IS_LOCAL: 'true' }, false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('EmailService BASE_URL guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when the transport is enabled but BASE_URL is unset', async () => {
    await expect(buildService({ IS_LOCAL: 'false' }, true)).rejects.toThrow(/BASE_URL is required/);
  });

  it('does not require BASE_URL when the transport is disabled', async () => {
    const { service } = await buildService({ IS_LOCAL: 'false' }, false);
    expect(service['baseUrl']).toBe('');
  });
});

describe('EmailService send gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips sending (without throwing) and warns when the transport is disabled', async () => {
    const { service, logger } = await buildService({ IS_LOCAL: 'false' }, false);
    await reset(service);
    expect(send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Email not sent'));
  });

  it('delegates to the sender when enabled', async () => {
    const { service } = await buildService({ IS_LOCAL: 'false', BASE_URL: 'https://app.example.com' }, true);
    await reset(service);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@example.com', subject: 'Reset your password' }));
  });

  it('skips (logs, does not warn) when running locally even if enabled', async () => {
    const { service, logger } = await buildService({ IS_LOCAL: 'true', BASE_URL: 'https://app.example.com' }, true);
    await reset(service);
    expect(send).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Email not sent (local)'));
  });

  it('delivers locally when EMAIL_LOCAL_DELIVERY is set', async () => {
    const { service } = await buildService(
      { IS_LOCAL: 'true', EMAIL_LOCAL_DELIVERY: 'true', BASE_URL: 'https://app.example.com' },
      true,
    );
    await reset(service);
    expect(send).toHaveBeenCalledOnce();
  });
});
