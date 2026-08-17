import { ForbiddenException } from '@nestjs/common';
import { OrganizationMembershipRole } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';
import type { ContextService } from '../../../common/context/context.service';
import type { WebhookDeliveryService } from '../../../webhook/webhook-delivery.service';
import type { WebhookService } from '../../../webhook/webhook.service';
import type { CreateWebhookDTO, UpdateWebhookDTO } from '../../../webhook/webhook.types';
import { OrganizationWebhooksService } from '../organization-webhooks.service';

const { Admin, Member } = OrganizationMembershipRole;

function build(callerRole: OrganizationMembershipRole) {
  const create = vi.fn().mockResolvedValue({
    id: 'wh-1',
    endpoint: 'https://example.com/hook',
    description: null,
    events: [],
    isActive: true,
    createdAt: new Date(),
    secret: 's',
  });
  const update = vi.fn().mockResolvedValue({
    id: 'wh-1',
    endpoint: 'https://example.com/hook',
    description: null,
    events: [],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const remove = vi.fn().mockResolvedValue(undefined);
  const findOne = vi
    .fn()
    .mockResolvedValue({ id: 'wh-1', organizationId: 'org-1', isActive: false, webhookId: 'wh-1' });
  const retryDelivery = vi.fn().mockResolvedValue({ success: true });
  const getDeliveryDetails = vi.fn().mockResolvedValue({ webhookId: 'wh-1' });

  const ctx = {
    role: callerRole,
    organizationId: 'org-1',
    requirePermission: vi.fn((resource: string, action: string) => {
      if (callerRole === Member && action !== 'read') {
        throw new ForbiddenException(`missing permission ${resource}:${action}`);
      }
    }),
  } as unknown as ContextService;

  const webhookService = { create, update, remove, findOne } as unknown as WebhookService;
  const webhookDeliveryService = {
    retryDelivery,
    getDeliveryDetails,
  } as unknown as WebhookDeliveryService;

  const service = new OrganizationWebhooksService(ctx, webhookService, webhookDeliveryService);
  return { service, create, update, remove, retryDelivery };
}

const createDto = { endpoint: 'https://example.com/hook', events: [] } as unknown as CreateWebhookDTO;
const updateDto = {
  endpoint: 'https://example.com/hook',
  events: [],
  isActive: true,
} as unknown as UpdateWebhookDTO;

describe('OrganizationWebhooksService role enforcement', () => {
  it('rejects a Member creating a webhook', async () => {
    const { service, create } = build(Member);
    await expect(service.createWebhook(createDto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });

  it('allows an Admin creating a webhook', async () => {
    const { service, create } = build(Admin);
    await expect(service.createWebhook(createDto)).resolves.toBeDefined();
    expect(create).toHaveBeenCalled();
  });

  it('rejects a Member updating a webhook', async () => {
    const { service, update } = build(Member);
    await expect(service.updateWebhook('wh-1', updateDto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('allows an Admin updating a webhook', async () => {
    const { service, update } = build(Admin);
    await expect(service.updateWebhook('wh-1', updateDto)).resolves.toBeDefined();
    expect(update).toHaveBeenCalled();
  });

  it('rejects a Member deleting a webhook', async () => {
    const { service, remove } = build(Member);
    await expect(service.deleteWebhook('wh-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(remove).not.toHaveBeenCalled();
  });

  it('allows an Admin deleting a webhook', async () => {
    const { service, remove } = build(Admin);
    await service.deleteWebhook('wh-1');
    expect(remove).toHaveBeenCalled();
  });

  it('rejects a Member retrying a delivery', async () => {
    const { service, retryDelivery } = build(Member);
    await expect(service.retryDelivery('del-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(retryDelivery).not.toHaveBeenCalled();
  });

  it('allows an Admin retrying a delivery', async () => {
    const { service, retryDelivery } = build(Admin);
    await expect(service.retryDelivery('del-1')).resolves.toBeDefined();
    expect(retryDelivery).toHaveBeenCalled();
  });
});
