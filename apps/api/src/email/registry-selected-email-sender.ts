import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailMessage, EmailSender } from './email-sender';
import { EmailTransportRegistry } from './email-transport-registry';
import { NodemailerEmailSender } from './nodemailer-email-sender';

@Injectable()
export class RegistrySelectedEmailSender implements EmailSender {
  constructor(
    @Inject(NodemailerEmailSender) private readonly fallback: EmailSender,
    private readonly configService: ConfigService,
  ) {}

  private active(): EmailSender {
    const provider = this.configService.get<string>('EMAIL_PROVIDER') ?? 'nodemailer';
    if (provider === 'nodemailer') return this.fallback;
    return EmailTransportRegistry.resolve(provider) ?? this.fallback;
  }

  get enabled(): boolean {
    return this.active().enabled;
  }

  send(message: EmailMessage): Promise<void> {
    return this.active().send(message);
  }
}
