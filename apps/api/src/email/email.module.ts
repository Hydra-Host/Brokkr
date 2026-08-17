import { Module } from '@nestjs/common';
import { CommonModule } from 'src/common/common.module';
import { EMAIL_SENDER } from './email-sender';
import { EmailService } from './email.service';
import { NodemailerEmailSender } from './nodemailer-email-sender';
import { RegistrySelectedEmailSender } from './registry-selected-email-sender';

@Module({
  imports: [CommonModule],
  providers: [
    NodemailerEmailSender,
    RegistrySelectedEmailSender,
    { provide: EMAIL_SENDER, useExisting: RegistrySelectedEmailSender },
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}
