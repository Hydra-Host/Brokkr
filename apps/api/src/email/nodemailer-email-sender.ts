import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from './email-sender';

@Injectable()
export class NodemailerEmailSender implements EmailSender {
  readonly enabled: boolean;
  private readonly fromAddress: string;
  private readonly transporter?: Transporter;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = parseInt(this.configService.get<string>('SMTP_PORT') ?? '587', 10);
    const secure = this.configService.get('SMTP_SECURE') === 'true';
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');
    this.fromAddress = this.configService.get<string>('EMAIL_FROM') ?? '';
    this.enabled = Boolean(host && this.fromAddress);

    if (this.enabled) {
      this.transporter = createTransport({
        host,
        port,
        secure,
        ...(user && pass ? { auth: { user, pass } } : {}),
      });
    }
  }

  async send(message: EmailMessage): Promise<void> {
    if (!this.transporter) return;
    await this.transporter.sendMail({
      from: message.from || this.fromAddress,
      to: message.to,
      subject: message.subject,
      html: message.html,
    });
  }
}
