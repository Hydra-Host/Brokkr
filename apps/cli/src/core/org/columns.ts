import type { TableColumn } from '../../tui/components/table-renderer.js';
import { formatDate, formatTenantType } from '../../ui/format.js';
import type { ApiKeyListItem } from './api-keys.js';
import type { InvitationDetail, InvitationListItem } from './invitations.js';
import type { MemberDetail, MemberListItem } from './members.js';
import type { OrgSettings } from './settings.js';
import type { WebhookDeliveryListItem, WebhookListItem, WebhookStatsData } from './webhooks.js';

export function orgSettingsDetailFields(s: OrgSettings): { label: string; value: string }[] {
  return [
    { label: 'ID', value: s.id },
    { label: 'Name', value: s.name },
    { label: 'Type', value: formatTenantType(s.tenantType) },
    { label: 'Email', value: s.email ?? '—' },
    { label: 'Country', value: s.country ?? '—' },
    { label: 'Logo', value: s.logo ?? '—' },
    { label: 'Created', value: formatDate(s.createdAt) },
    { label: 'Updated', value: s.updatedAt ? formatDate(s.updatedAt) : '—' },
  ];
}

export const memberListColumns: TableColumn<MemberListItem>[] = [
  { header: 'ID', accessor: (r) => r.id, width: 38 },
  { header: 'Name', accessor: (r) => r.name ?? '—', width: 24 },
  { header: 'Email', accessor: (r) => r.email, width: 30 },
  { header: 'Role', accessor: (r) => r.role, width: 12 },
  { header: 'Joined', accessor: (r) => formatDate(r.createdAt), width: 14 },
];

export function memberDetailFields(m: MemberDetail): { label: string; value: string }[] {
  return [
    { label: 'ID', value: m.id },
    { label: 'User ID', value: m.userId },
    { label: 'Organization ID', value: m.organizationId },
    { label: 'Role', value: m.role },
    { label: 'Created', value: formatDate(m.createdAt) },
    { label: 'Updated', value: formatDate(m.updatedAt) },
    { label: 'Deleted', value: m.deletedAt ? formatDate(m.deletedAt) : '—' },
  ];
}

export const invitationListColumns: TableColumn<InvitationListItem>[] = [
  { header: 'ID', accessor: (r) => r.id, width: 38 },
  { header: 'Email', accessor: (r) => r.email, width: 30 },
  { header: 'Role', accessor: (r) => r.role, width: 10 },
  { header: 'Status', accessor: (r) => r.status, width: 12 },
  { header: 'Created', accessor: (r) => formatDate(r.createdAt), width: 14 },
  { header: 'Expires', accessor: (r) => formatDate(r.expiresAt), width: 14 },
];

export function invitationDetailFields(inv: InvitationDetail): { label: string; value: string }[] {
  return [
    { label: 'ID', value: inv.id },
    { label: 'Email', value: inv.email },
    { label: 'Role', value: inv.role },
    { label: 'Role ID', value: inv.roleId ?? 'Private' },
    { label: 'Status', value: inv.status },
    { label: 'Inviter ID', value: inv.inviterId },
    { label: 'Organization ID', value: inv.organizationId },
    { label: 'Created', value: formatDate(inv.createdAt) },
    { label: 'Expires', value: formatDate(inv.expiresAt) },
  ];
}

export const apiKeyListColumns: TableColumn<ApiKeyListItem>[] = [
  { header: 'Name', accessor: (r) => r.name ?? '—', width: 20 },
  { header: 'Key', accessor: (r) => (r.start ? `${r.start}...` : '—'), width: 18 },
  { header: 'Role', accessor: (r) => r.role, width: 10 },
  { header: 'Enabled', accessor: (r) => (r.enabled ? '✓' : '✗'), width: 9 },
  { header: 'Requests', accessor: (r) => String(r.requestCount), width: 10 },
  { header: 'Created', accessor: (r) => formatDate(r.createdAt), width: 14 },
  { header: 'Expires', accessor: (r) => (r.expiresAt ? formatDate(r.expiresAt) : 'Never'), width: 14 },
  { header: 'Created By', accessor: (r) => r.createdByName ?? r.createdByEmail, width: 20 },
];

export function apiKeyDetailFields(k: ApiKeyListItem): { label: string; value: string }[] {
  return [
    { label: 'ID', value: k.id },
    { label: 'Name', value: k.name ?? '—' },
    { label: 'Key Preview', value: k.start ? `${k.start}...` : '—' },
    { label: 'Role', value: k.role },
    { label: 'Enabled', value: k.enabled ? 'Yes' : 'No' },
    { label: 'Requests', value: String(k.requestCount) },
    { label: 'Remaining', value: k.remaining != null ? String(k.remaining) : 'Unlimited' },
    { label: 'Last Request', value: k.lastRequest ? formatDate(k.lastRequest) : '—' },
    { label: 'Created', value: formatDate(k.createdAt) },
    { label: 'Expires', value: k.expiresAt ? formatDate(k.expiresAt) : 'Never' },
    { label: 'Created By', value: k.createdByName ?? k.createdByEmail },
  ];
}

export const webhookListColumns: TableColumn<WebhookListItem>[] = [
  { header: 'ID', accessor: (r) => r.id, width: 38 },
  { header: 'Endpoint', accessor: (r) => r.endpoint, width: 40 },
  { header: 'Events', accessor: (r) => String(r.events.length), width: 8 },
  { header: 'Active', accessor: (r) => (r.isActive ? '✓' : '✗'), width: 8 },
  { header: 'Created', accessor: (r) => formatDate(r.createdAt), width: 14 },
];

export function webhookDetailFields(wh: WebhookListItem): { label: string; value: string }[] {
  return [
    { label: 'ID', value: wh.id },
    { label: 'Endpoint', value: wh.endpoint },
    { label: 'Description', value: wh.description ?? '—' },
    { label: 'Active', value: wh.isActive ? 'Yes' : 'No' },
    { label: 'Events', value: wh.events.join(', ') },
    { label: 'Created', value: formatDate(wh.createdAt) },
    { label: 'Updated', value: wh.updatedAt ? formatDate(wh.updatedAt) : '—' },
  ];
}

export const webhookDeliveryListColumns: TableColumn<WebhookDeliveryListItem>[] = [
  { header: 'ID', accessor: (r) => r.id, width: 38 },
  { header: 'Endpoint', accessor: (r) => r.webhookEndpoint, width: 32 },
  { header: 'Event', accessor: (r) => r.eventType, width: 30 },
  { header: 'Status', accessor: (r) => r.status, width: 10 },
  { header: 'Code', accessor: (r) => (r.statusCode != null ? String(r.statusCode) : '—'), width: 6 },
  { header: 'Attempts', accessor: (r) => String(r.attemptNumber), width: 9 },
  { header: 'Created', accessor: (r) => formatDate(r.createdAt), width: 14 },
];

export function webhookStatsFields(s: WebhookStatsData): { label: string; value: string }[] {
  return [
    { label: 'Total Webhooks', value: String(s.total) },
    { label: 'Active', value: String(s.active) },
    { label: 'Failed Deliveries', value: String(s.failed) },
    { label: 'Recent Deliveries', value: String(s.recentDeliveries.length) },
  ];
}
