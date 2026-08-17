import { FormCombobox } from '@repo/ui/form/form-combobox';
import { keepPreviousData } from '@tanstack/react-query';
import { useState } from 'react';
import type { Control, FieldValues, Path } from 'react-hook-form';
import { tsr } from '~/lib/api';

interface FkProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label?: string;
}

interface ComboboxOption {
  value: string;
  label: string;
}

interface SeedableFkProps<T extends FieldValues> extends FkProps<T> {
  seedOption?: ComboboxOption;
}

export function ProviderCombobox<T extends FieldValues>({ control, name, label = 'Provider' }: FkProps<T>) {
  const { data } = tsr.listProviders.useQuery({ queryKey: ['providers', 'fk'], queryData: { query: {} } });
  const options = data?.status === 200 ? data.body.map((p) => ({ value: p.id, label: p.name })) : [];
  return <FormCombobox control={control} name={name} label={label} options={options} placeholder="Select a provider" />;
}

export function CircuitTypeCombobox<T extends FieldValues>({ control, name, label = 'Circuit type' }: FkProps<T>) {
  const { data } = tsr.listCircuitTypes.useQuery({ queryKey: ['circuit-types', 'fk'], queryData: { query: {} } });
  const options = data?.status === 200 ? data.body.map((t) => ({ value: t.id, label: t.name })) : [];
  return (
    <FormCombobox control={control} name={name} label={label} options={options} placeholder="Select a circuit type" />
  );
}

export function CircuitCombobox<T extends FieldValues>({ control, name, label = 'Circuit' }: FkProps<T>) {
  const { data } = tsr.listCircuits.useQuery({ queryKey: ['circuits', 'fk'], queryData: { query: {} } });
  const options = data?.status === 200 ? data.body.map((c) => ({ value: c.id, label: c.cid })) : [];
  return <FormCombobox control={control} name={name} label={label} options={options} placeholder="Select a circuit" />;
}

export function AsnCombobox<T extends FieldValues>({ control, name, label = 'ASN' }: FkProps<T>) {
  const { data } = tsr.listAsns.useQuery({ queryKey: ['asns', 'fk'], queryData: { query: {} } });
  const options =
    data?.status === 200
      ? data.body.map((a) => ({ value: a.id, label: a.description ? `${a.asn} (${a.description})` : String(a.asn) }))
      : [];
  return <FormCombobox control={control} name={name} label={label} options={options} placeholder="Select an ASN" />;
}

export function PrefixRoleCombobox<T extends FieldValues>({ control, name, label = 'Netplan role' }: FkProps<T>) {
  const { data } = tsr.listIpamRoles.useQuery({ queryKey: ['ipam-roles', 'fk'], queryData: { query: {} } });
  const options = data?.status === 200 ? data.body.map((r) => ({ value: r.id, label: `${r.name} (${r.slug})` })) : [];
  return <FormCombobox control={control} name={name} label={label} options={options} placeholder="Select a role" />;
}

// zoneId filter: undefined = all prefixes, null = zone-unassigned prefixes only, string = that zone's prefixes.
export function filterPrefixesByZone<P extends { zoneId: string | null }>(
  prefixes: P[],
  zoneId: string | null | undefined,
): P[] {
  if (zoneId === undefined) return prefixes;
  return prefixes.filter((p) => p.zoneId === zoneId);
}

export function PrefixCombobox<T extends FieldValues>({
  control,
  name,
  label = 'Prefix',
  zoneId,
  disabled,
  placeholder = 'Select a prefix',
}: FkProps<T> & { zoneId?: string | null; disabled?: boolean; placeholder?: string }) {
  const { data } = tsr.listPrefixes.useQuery({ queryKey: ['prefixes', 'fk'], queryData: { query: {} } });
  const options =
    data?.status === 200 ? filterPrefixesByZone(data.body, zoneId).map((p) => ({ value: p.id, label: p.prefix })) : [];
  return (
    <FormCombobox
      control={control}
      name={name}
      label={label}
      options={options}
      disabled={disabled}
      placeholder={placeholder}
    />
  );
}

export function VrfCombobox<T extends FieldValues>({ control, name, label = 'VRF' }: FkProps<T>) {
  const { data } = tsr.listVrfs.useQuery({ queryKey: ['vrfs', 'fk'], queryData: { query: {} } });
  const options =
    data?.status === 200 ? data.body.map((v) => ({ value: v.id, label: v.rd ? `${v.name} (${v.rd})` : v.name })) : [];
  return <FormCombobox control={control} name={name} label={label} options={options} placeholder="Select a VRF" />;
}

export function BgpPeerGroupCombobox<T extends FieldValues>({ control, name, label = 'Peer group' }: FkProps<T>) {
  const { data } = tsr.listBgpPeerGroups.useQuery({ queryKey: ['bgp-peer-groups', 'fk'], queryData: { query: {} } });
  const options = data?.status === 200 ? data.body.map((g) => ({ value: g.id, label: g.name })) : [];
  return (
    <FormCombobox control={control} name={name} label={label} options={options} placeholder="Select a peer group" />
  );
}

export function PrefixListCombobox<T extends FieldValues>({ control, name, label = 'Prefix list' }: FkProps<T>) {
  const { data } = tsr.listPrefixLists.useQuery({ queryKey: ['prefix-lists', 'fk'], queryData: { query: {} } });
  const options = data?.status === 200 ? data.body.map((pl) => ({ value: pl.id, label: pl.name })) : [];
  return (
    <FormCombobox control={control} name={name} label={label} options={options} placeholder="Select a prefix list" />
  );
}

export function DeviceCombobox<T extends FieldValues>({
  control,
  name,
  label = 'Device',
  seedOption,
}: SeedableFkProps<T>) {
  const [search, setSearch] = useState('');
  const { data } = tsr.getServers.useQuery({
    queryKey: ['devices', 'fk', search],
    queryData: { query: { search: search || undefined, pageSize: 50 } },
    placeholderData: keepPreviousData,
  });
  const options = data?.status === 200 ? data.body.data.map((d) => ({ value: d.id, label: d.name ?? d.id })) : [];
  const mergedOptions =
    seedOption && !options.find((o) => o.value === seedOption.value) ? [seedOption, ...options] : options;
  return (
    <FormCombobox
      control={control}
      name={name}
      label={label}
      options={mergedOptions}
      placeholder="Search devices…"
      searchValue={search}
      onSearchChange={setSearch}
      emptyMessage="No devices found"
    />
  );
}

export function IpAddressCombobox<T extends FieldValues>({
  control,
  name,
  label = 'IP address',
  seedOption,
}: SeedableFkProps<T>) {
  const [search, setSearch] = useState('');
  const { data } = tsr.listIpAddresses.useQuery({
    queryKey: ['ip-addresses', 'fk', search],
    queryData: { query: { search: search || undefined, pageSize: 50 } },
    placeholderData: keepPreviousData,
  });
  const options = data?.status === 200 ? data.body.map((ip) => ({ value: ip.id, label: ip.address })) : [];
  const mergedOptions =
    seedOption && !options.find((o) => o.value === seedOption.value) ? [seedOption, ...options] : options;
  return (
    <FormCombobox
      control={control}
      name={name}
      label={label}
      options={mergedOptions}
      placeholder="Search IP addresses…"
      searchValue={search}
      onSearchChange={setSearch}
      emptyMessage="No IP addresses found"
    />
  );
}

export function RearPortCombobox<T extends FieldValues>({
  control,
  name,
  deviceId,
  label = 'Rear port',
}: FkProps<T> & { deviceId?: string }) {
  const { data } = tsr.listDcimRearPorts.useQuery({
    queryKey: ['dcim-rear-ports', 'fk', deviceId],
    queryData: { query: { deviceId, pageSize: 100 } },
    enabled: !!deviceId,
  });
  const options = data?.status === 200 ? data.body.data.map((rp) => ({ value: rp.id, label: rp.name })) : [];
  return (
    <FormCombobox
      control={control}
      name={name}
      label={label}
      options={options}
      disabled={!deviceId}
      placeholder={deviceId ? 'Select a rear port' : 'Select a device first'}
    />
  );
}

export function ZoneCombobox<T extends FieldValues>({
  control,
  name,
  label = 'Zone',
  seedOption,
  description,
}: SeedableFkProps<T> & { description?: string }) {
  const [search, setSearch] = useState('');
  const { data } = tsr.getZones.useQuery({
    queryKey: ['zones', 'fk', search],
    queryData: { query: { search: search || undefined, pageSize: 50 } },
    placeholderData: keepPreviousData,
  });
  const options = data?.status === 200 ? data.body.data.map((z) => ({ value: z.id, label: z.name })) : [];
  const mergedOptions =
    seedOption && !options.find((o) => o.value === seedOption.value) ? [seedOption, ...options] : options;
  return (
    <FormCombobox
      control={control}
      name={name}
      label={label}
      options={mergedOptions}
      placeholder="Search zones…"
      searchValue={search}
      onSearchChange={setSearch}
      emptyMessage="No zones found"
      description={description}
    />
  );
}
