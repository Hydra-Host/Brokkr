import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailSender } from '../email-sender';
import { EmailTransportRegistry } from '../email-transport-registry';
import { RegistrySelectedEmailSender } from '../registry-selected-email-sender';

const fallbackSend = vi.fn();
const fallback: EmailSender = { enabled: true, send: fallbackSend };

const make = (provider?: string): RegistrySelectedEmailSender =>
  new RegistrySelectedEmailSender(fallback, { get: () => provider } as unknown as ConfigService);

const msg = { to: 'a@example.com', subject: 'Hi', html: '<p>x</p>' };

describe('RegistrySelectedEmailSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    EmailTransportRegistry.reset();
  });
  afterEach(() => EmailTransportRegistry.reset());

  it('delegates to the nodemailer fallback when EMAIL_PROVIDER is unset', async () => {
    await make(undefined).send(msg);
    expect(fallbackSend).toHaveBeenCalledWith(msg);
  });

  it('delegates to the fallback when EMAIL_PROVIDER=nodemailer', async () => {
    expect(make('nodemailer').enabled).toBe(true);
    await make('nodemailer').send(msg);
    expect(fallbackSend).toHaveBeenCalledOnce();
  });

  it('routes to a registered transport selected by EMAIL_PROVIDER', async () => {
    const mailgunSend = vi.fn();
    EmailTransportRegistry.register('mailgun', { enabled: true, send: mailgunSend });

    const sender = make('mailgun');
    expect(sender.enabled).toBe(true);
    await sender.send(msg);

    expect(mailgunSend).toHaveBeenCalledWith(msg);
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  it('falls back to nodemailer when the selected provider is not registered', async () => {
    await make('mailgun').send(msg);
    expect(fallbackSend).toHaveBeenCalledWith(msg);
  });

  it('resolves lazily — a transport registered after construction is picked up', async () => {
    const sender = make('mailgun');
    const mailgunSend = vi.fn();
    EmailTransportRegistry.register('mailgun', { enabled: true, send: mailgunSend });

    await sender.send(msg);
    expect(mailgunSend).toHaveBeenCalledWith(msg);
    expect(fallbackSend).not.toHaveBeenCalled();
  });
});
