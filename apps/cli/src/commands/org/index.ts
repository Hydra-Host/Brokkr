import { Command } from 'commander';
import { registerApiKeysCommand } from './api-keys.js';
import { registerCancelInvitationCommand } from './cancel-invitation.js';
import { registerCreateApiKeyCommand } from './create-api-key.js';
import { registerCreateWebhookCommand } from './create-webhook.js';
import { registerOrgCurrentCommand } from './current.js';
import { registerDeleteApiKeyCommand } from './delete-api-key.js';
import { registerDeleteWebhookCommand } from './delete-webhook.js';
import { registerInvitationsCommand } from './invitations.js';
import { registerInviteCommand } from './invite.js';
import { registerMembersCommand } from './members.js';
import { registerRemoveMemberCommand } from './remove-member.js';
import { registerRetryDeliveryCommand } from './retry-delivery.js';
import { registerOrgSelectCommand } from './select.js';
import { registerSettingsCommand } from './settings.js';
import { registerUpdateMemberRoleCommand } from './update-member-role.js';
import { registerUpdateSettingsCommand } from './update-settings.js';
import { registerUpdateWebhookCommand } from './update-webhook.js';
import { registerWebhooksCommand } from './webhooks.js';

export function registerOrgCommands(program: Command, opts?: { isBridge?: boolean }): void {
  const org = program.command('org').description('Organization management');

  registerOrgSelectCommand(org, opts);
  registerOrgCurrentCommand(org);
  registerSettingsCommand(org);
  registerUpdateSettingsCommand(org);
  registerMembersCommand(org);
  registerUpdateMemberRoleCommand(org);
  registerRemoveMemberCommand(org);
  registerInvitationsCommand(org);
  registerInviteCommand(org);
  registerCancelInvitationCommand(org);
  registerApiKeysCommand(org);
  registerCreateApiKeyCommand(org);
  registerDeleteApiKeyCommand(org);
  registerWebhooksCommand(org);
  registerCreateWebhookCommand(org);
  registerUpdateWebhookCommand(org);
  registerDeleteWebhookCommand(org);
  registerRetryDeliveryCommand(org);
}
