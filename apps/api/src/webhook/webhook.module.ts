import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookRepository } from './webhook.repository';
import { WebhookService } from './webhook.service';

@Module({
  imports: [
    PrismaModule,
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 0,
    }),
  ],
  providers: [WebhookService, WebhookDeliveryService, WebhookRepository, WebhookDeliveryRepository],
  exports: [WebhookService, WebhookDeliveryService, WebhookRepository],
})
export class WebhookModule {}
