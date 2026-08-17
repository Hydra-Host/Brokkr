import type { EmailMessage, PluginEmail } from '@hydrahost/plugin-sdk';
import { Injectable } from '@nestjs/common';

import { EmailService } from './email.service';

@Injectable()
export class HostPluginEmail implements PluginEmail {
  constructor(private readonly email: EmailService) {}

  send(message: EmailMessage): Promise<void> {
    return this.email.sendRaw(message);
  }
}
