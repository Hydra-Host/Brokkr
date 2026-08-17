export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
}

export interface EmailSender {
  readonly enabled: boolean;
  send(message: EmailMessage): Promise<void>;
}

export class EmailTransportRegistry {
  private static readonly transports = new Map<string, EmailSender>();

  static register(name: string, sender: EmailSender): void {
    this.transports.set(name, sender);
  }

  static resolve(name: string): EmailSender | undefined {
    return this.transports.get(name);
  }

  static reset(): void {
    this.transports.clear();
  }
}
