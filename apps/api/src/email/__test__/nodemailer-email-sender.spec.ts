import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({ createTransport }));

import { NodemailerEmailSender } from '../nodemailer-email-sender';

type Env = Record<string, string | undefined>;

const FULL: Env = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'u',
  SMTP_PASS: 'p',
  EMAIL_FROM: 'noreply@example.com',
};

const make = (env: Env): NodemailerEmailSender =>
  new NodemailerEmailSender({ get: (k: string) => env[k] } as unknown as ConfigService);

describe('NodemailerEmailSender', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is enabled when SMTP_HOST and EMAIL_FROM are set, and builds the transport', () => {
    const sender = make(FULL);
    expect(sender.enabled).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 587, secure: false, auth: { user: 'u', pass: 'p' } }),
    );
  });

  it.each(['SMTP_HOST', 'EMAIL_FROM'])('is disabled when %s is unset (no transport built)', (missing) => {
    const sender = make({ ...FULL, [missing]: undefined });
    expect(sender.enabled).toBe(false);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('sends via sendMail using the configured default From', async () => {
    await make(FULL).send({ to: 'a@example.com', subject: 'Hi', html: '<p>x</p>' });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'noreply@example.com', to: 'a@example.com', subject: 'Hi', html: '<p>x</p>' }),
    );
  });

  it('honors an explicit From override', async () => {
    await make(FULL).send({ to: 'a@example.com', subject: 'Hi', html: '<p>x</p>', from: 'custom@example.com' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'custom@example.com' }));
  });

  it('no-ops when disabled', async () => {
    await make({ ...FULL, SMTP_HOST: undefined }).send({ to: 'a@example.com', subject: 'Hi', html: '<p>x</p>' });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
