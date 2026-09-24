import { zodResolver } from '@hookform/resolvers/zod';
import { type DeviceInterfaceWithIps, DcimInterfaceTypeSchema, IpStatusSchema } from '@repo/api-client';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog';
import { Badge } from '@repo/ui/components/badge';
import { Button, buttonVariants } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Input } from '@repo/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@repo/ui/components/select';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Switch } from '@repo/ui/components/switch';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { cn } from '@repo/ui/utils';
import { pickDataInterface, unwrapErrorMessage } from '@repo/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';
import {
  type Draft,
  type NewRow,
  NONE,
  blankNewRow,
  buildPatch,
  formatSpeed,
  parseIntOrNull,
  toDraft,
  validateEdits,
} from './device-interfaces.utils';

type InterfaceIp = DeviceInterfaceWithIps['ipAddresses'][number];

const TYPE_OPTIONS = [
  { label: '—', value: NONE },
  ...DcimInterfaceTypeSchema.options.map((value) => ({ label: value, value })),
];

function interfacesQueryKey(deviceId: string) {
  return ['device-interfaces', deviceId];
}

interface DeviceInterfacesProps {
  deviceId: string;
  description?: string;
  emptyDescription?: string;
}

export function DeviceInterfaces({ deviceId, description, emptyDescription }: DeviceInterfacesProps) {
  const { data, isPending } = tsr.listDeviceInterfaces.useQuery({
    queryKey: interfacesQueryKey(deviceId),
    queryData: { params: { deviceId } },
  });

  if (isPending) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  // Only error when there's no usable data. TanStack Query can flag isError on a background refetch
  // failure while `data` still holds the last good response — don't wipe the table/editor for that.
  if (!data || data.status !== 200) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-destructive text-center text-sm">Failed to load interfaces. Please try again.</p>
        </CardContent>
      </Card>
    );
  }
  // default sort by interface name (natural order so eth2 precedes eth10)
  const interfaces = [...data.body].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const isInfiniBand = (i: DeviceInterfaceWithIps) =>
    i.linkType === 'INFINIBAND' || (!!i.guid && i.linkType !== 'ETHERNET');
  const ethInterfaces = interfaces.filter((i) => !isInfiniBand(i));
  const ibInterfaces = interfaces.filter(isInfiniBand);

  return (
    <div className="space-y-6">
      <InterfaceTable
        variant="ethernet"
        interfaces={ethInterfaces}
        allInterfaces={interfaces}
        deviceId={deviceId}
        description={description}
        emptyDescription={emptyDescription}
      />
      {ibInterfaces.length > 0 && (
        <InterfaceTable variant="infiniband" interfaces={ibInterfaces} allInterfaces={interfaces} deviceId={deviceId} />
      )}
    </div>
  );
}

function InterfaceTable({
  variant,
  interfaces,
  allInterfaces,
  deviceId,
  description,
  emptyDescription,
}: {
  variant: 'ethernet' | 'infiniband';
  interfaces: DeviceInterfaceWithIps[];
  allInterfaces: DeviceInterfaceWithIps[];
  deviceId: string;
  description?: string;
  emptyDescription?: string;
}) {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canEdit = can('dcim', 'update');
  const canAssignIp = can('ipam', 'create');
  const canUnassignIp = can('ipam', 'update');
  const pxe = pickDataInterface(allInterfaces);
  const pxeInterfaceId = pxe?.iface.id;
  const pxeReason = pxe?.tier === 'address' ? 'PXE: holds an IP address' : 'PXE: first data interface by name';

  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [markedDelete, setMarkedDelete] = useState<Set<string>>(new Set());
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const bulkMutation = tsr.bulkUpdateDeviceInterfaces.useMutation();
  const isBusy = bulkMutation.isPending;

  const start = (withRow = false) => {
    setBulkError(null);
    setDrafts(Object.fromEntries(interfaces.map((i) => [i.id, toDraft(i)])));
    setMarkedDelete(new Set());
    setNewRows(withRow ? [blankNewRow()] : []);
    setEditing(true);
  };
  const cancel = () => {
    setBulkError(null);
    setDrafts({});
    setMarkedDelete(new Set());
    setNewRows([]);
    setEditing(false);
  };
  const setField = (id: string, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const toggleDelete = (id: string) =>
    setMarkedDelete((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const addRow = () => (editing ? setNewRows((prev) => [...prev, blankNewRow()]) : start(true));
  const setNewField = (tempId: string, patch: Partial<Draft>) =>
    setNewRows((prev) => prev.map((r) => (r.tempId === tempId ? { ...r, ...patch } : r)));
  const removeNewRow = (tempId: string) => setNewRows((prev) => prev.filter((r) => r.tempId !== tempId));

  const validation = editing
    ? validateEdits({ interfaces, allInterfaces, drafts, newRows, markedDelete })
    : { byId: {}, byTempId: {}, hasErrors: false };

  const save = async () => {
    if (validation.hasErrors) return;
    const updates = interfaces
      .filter((i) => !markedDelete.has(i.id) && drafts[i.id] != null)
      .map((i) => ({ id: i.id, body: buildPatch(i, drafts[i.id]!) }))
      .filter((c) => Object.keys(c.body).length > 0)
      .map((c) => ({ id: c.id, ...c.body }));
    const creates = newRows
      .filter((r) => r.name.trim() !== '')
      .map((r) => ({
        name: r.name.trim(),
        type: r.type === NONE ? undefined : DcimInterfaceTypeSchema.parse(r.type),
        macAddress: r.macAddress.trim() || undefined,
        speed: parseIntOrNull(r.speed) ?? undefined,
        mtu: parseIntOrNull(r.mtu) ?? undefined,
        enabled: r.enabled,
        markConnected: r.markConnected,
      }));
    const deletes = [...markedDelete];
    if (updates.length === 0 && creates.length === 0 && deletes.length === 0) {
      cancel();
      return;
    }
    // The server rolls the whole batch back on any failure, so only clear drafts and leave edit mode
    // on SUCCESS — a 4xx/5xx applied nothing and the operator's in-progress edits stay for retry.
    setBulkError(null); // clear a prior attempt's error so it doesn't linger during this retry
    let result;
    try {
      result = await bulkMutation.mutateAsync({ params: { deviceId }, body: { deletes, updates, creates } });
    } catch (error) {
      // Thrown only for unknown statuses / network failures — ts-rest resolves known 4xx below.
      setBulkError(unwrapErrorMessage(error, 'Failed to save interfaces'));
      return;
    }
    // ts-rest resolves contract error statuses (400/404/401/403) instead of throwing, so a non-204
    // result is a failed apply — surface it rather than wiping the operator's edits.
    if (result.status !== 204) {
      setBulkError(unwrapErrorMessage(result, 'Failed to save interfaces'));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: interfacesQueryKey(deviceId) });
    cancel();
  };

  const isEthernet = variant === 'ethernet';
  const title = isEthernet ? 'Network Interfaces' : 'InfiniBand / RDMA';
  const cardDescription = isEthernet
    ? (description ?? `${interfaces.length} interface${interfaces.length !== 1 ? 's' : ''}`)
    : `${interfaces.length} port${interfaces.length !== 1 ? 's' : ''} — ${interfaces.filter((i) => i.enabled).length} active`;

  const columnCount = 9;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{cardDescription}</CardDescription>
        </div>
        {canEdit &&
          (editing ? (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={cancel} disabled={isBusy}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={isBusy || validation.hasErrors}>
                {isBusy ? 'Saving...' : 'Save'}
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => start()}>
              <Pencil className="size-3" />
              &nbsp;Edit
            </Button>
          ))}
      </CardHeader>
      {bulkError && (
        <div className="px-6 pb-2">
          <span className="text-destructive text-xs">{bulkError}</span>
        </div>
      )}
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border-dim border-b text-left">
                {isEthernet ? (
                  <>
                    <th className="pr-4 pb-2 font-medium">Name</th>
                    <th className="pr-4 pb-2 font-medium">Type</th>
                    <th className="pr-4 pb-2 font-medium">MAC</th>
                    <th className="pr-4 pb-2 font-medium">Speed</th>
                    <th className="pr-4 pb-2 font-medium">MTU</th>
                    <th className="pr-4 pb-2 font-medium">IPs</th>
                    <th className="pr-4 pb-2 font-medium">Status</th>
                    <th className="pr-4 pb-2 font-medium">Connected</th>
                    <th className="pb-2 font-medium">LLDP Neighbor</th>
                  </>
                ) : (
                  <>
                    <th className="pr-4 pb-2 font-medium">Port</th>
                    <th className="pr-4 pb-2 font-medium">Link Type</th>
                    <th className="pr-4 pb-2 font-medium">Max Speed</th>
                    <th className="pr-4 pb-2 font-medium">GUID</th>
                    <th className="pr-4 pb-2 font-medium">MTU</th>
                    <th className="pr-4 pb-2 font-medium">IPs</th>
                    <th className="pr-4 pb-2 font-medium">State</th>
                    <th className="pr-4 pb-2 font-medium">Status</th>
                    <th className="pb-2 font-medium">Connected</th>
                  </>
                )}
                {editing && <th className="pb-2" />}
              </tr>
            </thead>
            <tbody>
              {interfaces.map((iface) => {
                const d = drafts[iface.id];
                const marked = markedDelete.has(iface.id);
                const rowErrors = validation.byId[iface.id];
                return (
                  <tr
                    key={iface.id}
                    className={cn(
                      'border-border-dim border-b align-middle last:border-b-0',
                      marked && 'text-muted-foreground line-through opacity-60',
                    )}
                  >
                    <td className="py-2 pr-4">
                      {editing ? (
                        <CellInput
                          value={d.name}
                          onChange={(v) => setField(iface.id, { name: v })}
                          error={rowErrors?.name}
                          mono
                        />
                      ) : (
                        <span className="inline-flex items-center font-mono text-xs">
                          {iface.name}
                          {iface.mgmtOnly && (
                            <Badge variant="outline" className="ml-2 text-xs">
                              MGMT
                            </Badge>
                          )}
                          {iface.id === pxeInterfaceId && (
                            <Badge variant="outline" className="ml-2 text-xs" title={pxeReason}>
                              PXE
                            </Badge>
                          )}
                        </span>
                      )}
                    </td>

                    {isEthernet && (
                      <td className="py-2 pr-4">
                        {editing ? (
                          <CellSelect
                            value={d.type}
                            onChange={(v) => setField(iface.id, { type: v })}
                            options={TYPE_OPTIONS}
                          />
                        ) : (
                          <span className="text-muted-foreground text-xs">{iface.type || '--'}</span>
                        )}
                      </td>
                    )}

                    {!isEthernet && (
                      <td className="py-2 pr-4">
                        <Badge variant={iface.linkType === 'INFINIBAND' ? 'default' : 'secondary'}>
                          {iface.linkType || iface.type || '--'}
                        </Badge>
                      </td>
                    )}
                    {!isEthernet && (
                      <td className="py-2 pr-4">{iface.maxSpeedGbps ? `${iface.maxSpeedGbps} Gbps` : '--'}</td>
                    )}
                    {!isEthernet && <td className="py-2 pr-4 font-mono text-xs">{iface.guid || '--'}</td>}

                    {isEthernet && (
                      <td className="py-2 pr-4">
                        {editing ? (
                          <CellInput
                            value={d.macAddress}
                            onChange={(v) => setField(iface.id, { macAddress: v })}
                            error={rowErrors?.macAddress}
                            mono
                          />
                        ) : (
                          <span className="font-mono text-xs">{iface.macAddress || '--'}</span>
                        )}
                      </td>
                    )}

                    {isEthernet && (
                      <td className="py-2 pr-4">
                        {editing ? (
                          <CellInput
                            value={d.speed}
                            onChange={(v) => setField(iface.id, { speed: v })}
                            error={rowErrors?.speed}
                            type="number"
                          />
                        ) : (
                          formatSpeed(iface.speed)
                        )}
                      </td>
                    )}

                    <td className="py-2 pr-4">
                      {editing ? (
                        <CellInput
                          value={d.mtu}
                          onChange={(v) => setField(iface.id, { mtu: v })}
                          error={rowErrors?.mtu}
                          type="number"
                        />
                      ) : (
                        (iface.mtu ?? '--')
                      )}
                    </td>

                    <td className="py-2 pr-4">
                      <IpCell
                        iface={iface}
                        editing={editing}
                        deviceId={deviceId}
                        canAssign={canAssignIp}
                        canUnassign={canUnassignIp}
                      />
                    </td>

                    {!isEthernet && <td className="py-2 pr-4 text-xs">{iface.portState || '--'}</td>}

                    <td className="py-2 pr-4">
                      {editing ? (
                        <Switch checked={d.enabled} onCheckedChange={(c) => setField(iface.id, { enabled: c })} />
                      ) : (
                        <Badge variant={iface.enabled ? 'default' : 'secondary'}>{iface.enabled ? 'Up' : 'Down'}</Badge>
                      )}
                    </td>

                    <td className="py-2 pr-4">
                      {editing ? (
                        <Switch
                          checked={d.markConnected}
                          onCheckedChange={(c) => setField(iface.id, { markConnected: c })}
                        />
                      ) : iface.markConnected ? (
                        <Badge variant="outline" className="text-xs">
                          yes
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">--</span>
                      )}
                    </td>

                    {isEthernet && (
                      <td className="py-2">
                        {iface.lldpNeighborName ? (
                          <span className="text-xs">
                            {iface.lldpNeighborName}
                            {iface.lldpNeighborPort && (
                              <span className="text-muted-foreground"> port {iface.lldpNeighborPort}</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </td>
                    )}

                    {editing && (
                      <td className="py-2">
                        <button
                          type="button"
                          onClick={() => toggleDelete(iface.id)}
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={marked ? 'Restore interface' : 'Delete interface'}
                        >
                          {marked ? <RotateCcw className="size-3.5" /> : <Trash2 className="size-3.5" />}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}

              {editing &&
                newRows.map((r) => {
                  const newErrors = validation.byTempId[r.tempId];
                  const dash = <span className="text-muted-foreground">--</span>;
                  return (
                    <tr key={r.tempId} className="border-border-dim bg-muted/30 border-b align-middle">
                      <td className="py-2 pr-4">
                        <CellInput
                          value={r.name}
                          onChange={(v) => setNewField(r.tempId, { name: v })}
                          error={newErrors?.name}
                          placeholder={isEthernet ? 'eth0' : 'ib0'}
                          mono
                        />
                      </td>

                      {isEthernet ? (
                        <td className="py-2 pr-4">
                          <CellSelect
                            value={r.type}
                            onChange={(v) => setNewField(r.tempId, { type: v })}
                            options={TYPE_OPTIONS}
                          />
                        </td>
                      ) : (
                        <td className="py-2 pr-4">{dash}</td>
                      )}

                      {!isEthernet && <td className="py-2 pr-4">{dash}</td>}
                      {!isEthernet && <td className="py-2 pr-4">{dash}</td>}

                      {isEthernet && (
                        <td className="py-2 pr-4">
                          <CellInput
                            value={r.macAddress}
                            onChange={(v) => setNewField(r.tempId, { macAddress: v })}
                            error={newErrors?.macAddress}
                            placeholder="MAC"
                            mono
                          />
                        </td>
                      )}

                      {isEthernet && (
                        <td className="py-2 pr-4">
                          <CellInput
                            value={r.speed}
                            onChange={(v) => setNewField(r.tempId, { speed: v })}
                            error={newErrors?.speed}
                            placeholder="speed"
                            type="number"
                          />
                        </td>
                      )}

                      <td className="py-2 pr-4">
                        <CellInput
                          value={r.mtu}
                          onChange={(v) => setNewField(r.tempId, { mtu: v })}
                          error={newErrors?.mtu}
                          placeholder="MTU"
                          type="number"
                        />
                      </td>

                      <td className="py-2 pr-4">{dash}</td>

                      {!isEthernet && <td className="py-2 pr-4">{dash}</td>}

                      <td className="py-2 pr-4">
                        <Switch checked={r.enabled} onCheckedChange={(c) => setNewField(r.tempId, { enabled: c })} />
                      </td>

                      <td className="py-2 pr-4">
                        <Switch
                          checked={r.markConnected}
                          onCheckedChange={(c) => setNewField(r.tempId, { markConnected: c })}
                        />
                      </td>

                      {isEthernet && <td className="py-2">{dash}</td>}

                      <td className="py-2">
                        <button
                          type="button"
                          onClick={() => removeNewRow(r.tempId)}
                          className="text-muted-foreground hover:text-destructive"
                          aria-label="Discard new interface"
                        >
                          <X className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}

              {interfaces.length === 0 && newRows.length === 0 && (
                <tr>
                  <td colSpan={columnCount + (editing ? 1 : 0)} className="text-muted-foreground py-6 text-center">
                    {editing
                      ? 'No interfaces — use “Add interface” below.'
                      : (emptyDescription ?? 'No interfaces found for this device.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={addRow} disabled={isBusy}>
            <Plus className="size-3" />
            &nbsp;Add interface
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ── in-cell editing primitives ─────────────────────────────────────────────

function CellInput({
  value,
  onChange,
  type = 'text',
  mono = false,
  placeholder,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'number';
  mono?: boolean;
  placeholder?: string;
  error?: string;
}) {
  return (
    <Input
      type={type}
      value={value}
      placeholder={placeholder}
      aria-invalid={error ? true : undefined}
      title={error}
      onChange={(e) => onChange(e.target.value)}
      className={mono ? 'h-8 font-mono text-xs' : 'h-8 text-xs'}
    />
  );
}

function CellSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="w-max">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── IP cell: badges in view mode; remove + add while editing ────────────────

function IpCell({
  iface,
  editing,
  deviceId,
  canAssign,
  canUnassign,
}: {
  iface: DeviceInterfaceWithIps;
  editing: boolean;
  deviceId: string;
  canAssign: boolean;
  canUnassign: boolean;
}) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [unassignError, setUnassignError] = useState<string | null>(null);
  const unassignMutation = tsr.updateIpAddress.useMutation();

  const [confirmIp, setConfirmIp] = useState<InterfaceIp | null>(null);

  // Clear a stale unassign error when leaving edit mode, so it doesn't linger in the read-only view
  // or into the next edit session.
  useEffect(() => {
    if (!editing) setUnassignError(null);
  }, [editing]);

  const onUnassign = async (ip: InterfaceIp) => {
    setUnassignError(null);
    setConfirmIp(null);
    let result;
    try {
      result = await unassignMutation.mutateAsync({ params: { id: ip.id }, body: { interfaceId: null } });
    } catch (error) {
      setUnassignError(`Failed to unassign ${ip.address}: ${unwrapErrorMessage(error, 'unknown error')}`);
      return;
    }
    // ts-rest resolves contract error statuses instead of throwing, so a non-200 is a failed unassign.
    if (result.status !== 200) {
      setUnassignError(`Failed to unassign ${ip.address}: ${unwrapErrorMessage(result, 'unknown error')}`);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: interfacesQueryKey(deviceId) });
  };

  const ips = iface.ipAddresses ?? [];
  if (ips.length === 0 && !editing) return <span className="text-muted-foreground">--</span>;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {ips.map((ip) => (
        <Badge key={ip.id} variant="outline" className="gap-1 font-mono text-xs">
          {ip.address}
          {editing && canUnassign && (
            <button
              type="button"
              onClick={() => setConfirmIp(ip)}
              disabled={unassignMutation.isPending}
              className="hover:text-destructive"
              aria-label={`Unassign ${ip.address}`}
            >
              <X className="size-3" />
            </button>
          )}
        </Badge>
      ))}
      <AlertDialog open={!!confirmIp} onOpenChange={(open) => !open && setConfirmIp(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unassign IP address</AlertDialogTitle>
            <AlertDialogDescription>
              Unassign {confirmIp?.address}? This removes the IP from the interface.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => {
                if (confirmIp) void onUnassign(confirmIp);
              }}
              disabled={unassignMutation.isPending}
            >
              Unassign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {editing && canAssign && (
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-6 px-2">
              <Plus className="size-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72">
            <p className="text-muted-foreground mb-2 text-xs">
              IP assignments apply immediately — they are not part of Save/Cancel.
            </p>
            <AddIpForm interfaceId={iface.id} deviceId={deviceId} onSuccess={() => setAddOpen(false)} />
          </PopoverContent>
        </Popover>
      )}
      {unassignError && <span className="text-destructive w-full text-xs">{unassignError}</span>}
    </div>
  );
}

const addIpSchema = z.object({
  address: z
    .string()
    .trim()
    .min(1, 'Address is required')
    // Accept a bare IP (v4/v6) or CIDR notation; the column is Postgres inet.
    .refine(
      (v) => z.string().ip().or(z.string().cidr()).safeParse(v).success,
      'Enter a valid IP or CIDR (e.g. 10.0.0.5 or 10.0.0.5/24)',
    ),
  status: IpStatusSchema,
  vrfId: z.string(),
});
type AddIpFormData = z.infer<typeof addIpSchema>;

function AddIpForm({
  interfaceId,
  deviceId,
  onSuccess,
}: {
  interfaceId: string;
  deviceId: string;
  onSuccess: () => void;
}) {
  const queryClient = useQueryClient();

  const { data: vrfsData } = tsr.listVrfs.useQuery({
    queryKey: ['vrfs', 'ip-assign'],
    queryData: { query: {} },
  });

  const createMutation = tsr.createIpAddress.useMutation();

  const vrfList = vrfsData?.status === 200 ? vrfsData.body : [];
  const vrfOptions = [{ label: 'None', value: NONE }, ...vrfList.map((v) => ({ label: v.name, value: v.id }))];

  const { control, handleSubmit, reset, setValue } = useForm<AddIpFormData>({
    resolver: zodResolver(addIpSchema),
    defaultValues: { address: '', status: 'ACTIVE', vrfId: NONE },
  });

  // when the org has exactly one VRF, preselect it instead of "None"
  const soleVrfId = vrfList.length === 1 ? vrfList[0].id : null;
  useEffect(() => {
    if (soleVrfId) setValue('vrfId', soleVrfId);
  }, [soleVrfId, setValue]);

  const [submitError, setSubmitError] = useState<string | null>(null);

  const onSubmit = async (form: AddIpFormData) => {
    setSubmitError(null);
    let result;
    try {
      result = await createMutation.mutateAsync({
        body: {
          address: form.address,
          status: form.status,
          vrfId: form.vrfId === NONE ? undefined : form.vrfId,
          interfaceId,
        },
      });
    } catch (error) {
      setSubmitError(unwrapErrorMessage(error, 'Failed to assign IP address'));
      return;
    }
    // ts-rest resolves contract error statuses instead of throwing, so a non-201 is a failed create.
    if (result.status !== 201) {
      setSubmitError(unwrapErrorMessage(result, 'Failed to assign IP address'));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: interfacesQueryKey(deviceId) });
    reset({ address: '', status: 'ACTIVE', vrfId: soleVrfId ?? NONE });
    onSuccess();
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      {submitError && <p className="text-destructive text-sm">{submitError}</p>}
      <FormInput control={control} name="address" label="Address (CIDR)" placeholder="10.0.0.5/24" />
      <FormSelect
        control={control}
        name="status"
        label="Status"
        options={IpStatusSchema.options.map((s) => ({ label: s, value: s }))}
      />
      <FormSelect control={control} name="vrfId" label="VRF" options={vrfOptions} />
      <Button type="submit" size="sm" disabled={createMutation.isPending}>
        {createMutation.isPending ? 'Assigning...' : 'Assign IP'}
      </Button>
    </form>
  );
}
