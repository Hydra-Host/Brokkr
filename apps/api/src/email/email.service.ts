import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { render } from '@react-email/components';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { EMAIL_SENDER, type EmailMessage, type EmailSender } from './email-sender';
import { DeviceProvisioningErrorEmail } from './templates/DeviceProvisioningErrorEmail';
import { EmailVerificationEmail } from './templates/EmailVerificationEmail';
import { ForgotPasswordEmailEmail } from './templates/ForgotPasswordEmail';
import { InterruptibleInitiatedEmail } from './templates/InterruptibleInitiatedEmail';
import { InterruptionCompleteEmail } from './templates/InterruptionCompleteEmail';
import { InterruptionQueuedEmail } from './templates/InterruptionQueuedEmail';
import { InvitationEmail } from './templates/InvitationEmail';
import { MagicPasswordLinkEmail } from './templates/MagicPasswordLinkEmail';
import { ProvisioningStartedEmail } from './templates/ProvisioningStartedEmail';
import { ReservationInvitationEmail } from './templates/ReservationInvitationEmail';
import { SupplierDeploymentProvisionSuccessEmail } from './templates/SupplierDeploymentProvisionSuccessEmail';
import { SupplierDeviceInInventoryEmail } from './templates/SupplierDeviceInInventoryEmail';

@Injectable()
export class EmailService implements OnApplicationBootstrap {
  protected readonly baseUrl: string;
  private readonly isLocal: boolean;
  private readonly localDelivery: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Logger(EmailService.name) private readonly logger: LoggerService,
  ) {
    this.isLocal = this.configService.get('IS_LOCAL') === 'true';
    this.localDelivery = this.configService.get('EMAIL_LOCAL_DELIVERY') === 'true';
    this.baseUrl = this.configService.get<string>('BASE_URL') ?? '';
  }

  onApplicationBootstrap(): void {
    if (this.sender.enabled && !this.baseUrl) {
      throw new Error('BASE_URL is required when an email transport is configured; set BASE_URL or leave it unset.');
    }

    if (!this.sender.enabled && !this.isLocal) {
      this.logger.warn('Email transport not configured; outbound email will be skipped.');
    }
  }

  private async sendEmail(options: { subject: string; html: string; to: string | string[]; from?: string }) {
    const skipForLocal = this.isLocal && !this.localDelivery;
    if (skipForLocal || !this.sender.enabled) {
      const recipients = Array.isArray(options.to) ? options.to.join(', ') : options.to;
      const message = `Email not sent (${skipForLocal ? 'local' : 'email not configured'}): "${options.subject}" → ${recipients}`;
      if (skipForLocal) this.logger.log(message);
      else this.logger.warn(message);
      return;
    }

    const recipients = Array.isArray(options.to) ? options.to.join(', ') : options.to;
    this.logger.log(`Sending email "${options.subject}" → ${recipients}`);
    try {
      await this.sender.send(options);
    } catch (error) {
      this.logger.error(`Failed to send email: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async sendRaw(message: EmailMessage): Promise<void> {
    await this.sendEmail(message);
  }

  send = {
    organizationInvite: async ({
      email,
      inviterName,
      organizationName,
    }: {
      email: string;
      inviterName: string;
      organizationName: string;
    }) => {
      await this.sendEmail({
        to: email,
        subject: 'Join your team!',
        html: await render(
          InvitationEmail({
            baseUrl: this.baseUrl,
            inviterName,
            organizationName,
          }),
        ),
      });
    },

    reservationInvite: async ({
      emails,
      reservationEndDate,
      from,
    }: {
      emails: string[];
      reservationEndDate: string;
      from: string;
    }) => {
      await this.sendEmail({
        to: emails,
        from,
        subject: 'You have been sent a device reservation!',
        html: await render(
          ReservationInvitationEmail({
            baseUrl: this.baseUrl,
            reservationEndDate,
          }),
        ),
      });
    },

    emailVerification: async ({
      code,
      email,
      expirationDate,
      firstName,
    }: {
      code: string;
      email: string;
      expirationDate: string;
      firstName: string;
    }) => {
      await this.sendEmail({
        to: email,
        subject: 'Email Verification',
        html: await render(
          EmailVerificationEmail({
            code,
            firstName,
            expirationDate,
          }),
        ),
      });
    },

    magicLink: async ({
      email,
      expirationInMinutes,
      firstName,
      magicLinkUrl,
    }: {
      email: string;
      expirationInMinutes: string;
      firstName: string;
      magicLinkUrl: string;
    }) => {
      await this.sendEmail({
        to: email,
        subject: 'Your magic link is here!',
        html: await render(
          MagicPasswordLinkEmail({
            firstName,
            magicLinkUrl,
            expirationInMinutes,
          }),
        ),
      });
    },

    passwordReset: async ({ email, firstName, url }: { email: string; firstName: string; url: string }) => {
      await this.sendEmail({
        to: email,
        subject: 'Reset your password',
        html: await render(
          ForgotPasswordEmailEmail({
            firstName,
            url,
          }),
        ),
      });
    },

    deviceError: async ({
      email,
      deviceName,
      userName,
    }: {
      email: string;
      deviceName: string;
      userName: string;
      ticketUrl?: string;
    }) => {
      await this.sendEmail({
        to: email,
        subject: 'Device Provisioning Error',
        html: await render(
          DeviceProvisioningErrorEmail({
            deviceName,
            userName,
          }),
        ),
      });
    },

    interruptionNotice: async ({
      emails,
      deploymentName,
      delayInMs,
    }: {
      emails: string | string[];
      deploymentName: string;
      delayInMs: number;
    }) => {
      await this.sendEmail({
        to: emails,
        subject: 'Deployment Interruption Notice',
        html: await render(
          InterruptibleInitiatedEmail({
            deploymentName,
            delayInMs,
          }),
        ),
      });
    },

    interruptionComplete: async ({ email, deploymentName }: { email: string; deploymentName: string }) => {
      await this.sendEmail({
        to: email,
        subject: 'Deployment Interruption Complete',
        html: await render(
          InterruptionCompleteEmail({
            deploymentName,
          }),
        ),
      });
    },

    interruptionQueued: async ({
      email,
      deploymentName,
      deviceId,
      delayInMs,
    }: {
      email: string;
      deploymentName: string;
      deviceId: string;
      delayInMs: number;
    }) => {
      await this.sendEmail({
        to: email,
        subject: 'Interruption Request Queued',
        html: await render(
          InterruptionQueuedEmail({
            deploymentName,
            deviceId,
            delayInMs,
          }),
        ),
      });
    },

    provisioningStarted: async ({
      email,
      deploymentName,
      deploymentId,
    }: {
      email: string;
      deploymentName: string;
      deploymentId: string;
    }) => {
      await this.sendEmail({
        to: email,
        subject: 'Provisioning Started',
        html: await render(
          ProvisioningStartedEmail({
            deploymentName,
            deploymentId,
            baseUrl: this.baseUrl,
          }),
        ),
      });
    },

    supplierDeviceInInventory: async ({
      emails,
      orgName,
      deviceId,
      primaryIp,
    }: {
      emails: string[];
      orgName: string;
      deviceId: string;
      primaryIp: string;
    }) => {
      await this.sendEmail({
        to: emails,
        subject: 'New Server Available as Inventory',
        html: await render(
          SupplierDeviceInInventoryEmail({
            orgName,
            deviceId,
            primaryIp,
            baseUrl: this.baseUrl,
          }),
        ),
      });
    },

    supplierDeviceProvisionSuccess: async ({
      emails,
      orgName,
      deviceId,
      primaryIp,
      reservationType,
    }: {
      emails: string[];
      orgName: string;
      deviceId: string;
      primaryIp: string;
      reservationType: 'Customer Rental' | 'Self-Provisioned';
    }) => {
      await this.sendEmail({
        to: emails,
        subject: 'New Server Rental',
        html: await render(
          SupplierDeploymentProvisionSuccessEmail({
            orgName,
            deviceId,
            reservationType,
            primaryIp,
            baseUrl: this.baseUrl,
          }),
        ),
      });
    },
  };
}
