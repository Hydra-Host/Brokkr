import type { TableColumn } from '../../tui/components/table-renderer.js';
import { formatDate } from '../../ui/format.js';
import type { ProfileDetail } from './profile.js';
import type { SshKeyDetail, SshKeyListItem } from './ssh-keys.js';

export const sshKeyListColumns: TableColumn<SshKeyListItem>[] = [
  { header: 'ID', accessor: (r) => r.id, width: 38 },
  { header: 'Name', accessor: (r) => r.name, width: 24 },
  { header: 'Created', accessor: (r) => formatDate(r.dateCreated), width: 14 },
  { header: 'Fingerprint', accessor: (r) => r.fingerprint, width: 66 },
];

export function sshKeyDetailFields(k: SshKeyDetail): { label: string; value: string }[] {
  return [
    { label: 'ID', value: k.id },
    { label: 'Name', value: k.name },
    { label: 'Fingerprint', value: k.fingerprint },
    { label: 'Created', value: formatDate(k.dateCreated) },
    { label: 'Deleted', value: k.dateDeleted ? formatDate(k.dateDeleted) : '—' },
    { label: 'Key', value: k.key },
  ];
}

export function profileDetailFields(p: ProfileDetail): { label: string; value: string }[] {
  const fullName = [p.firstName, p.lastName].filter(Boolean).join(' ') || p.name;
  return [
    { label: 'ID', value: p.id },
    { label: 'Email', value: p.email },
    { label: 'Name', value: fullName ?? '—' },
    { label: 'Created', value: p.createdAt ? formatDate(p.createdAt) : '—' },
    { label: 'Updated', value: p.updatedAt ? formatDate(p.updatedAt) : '—' },
  ];
}
