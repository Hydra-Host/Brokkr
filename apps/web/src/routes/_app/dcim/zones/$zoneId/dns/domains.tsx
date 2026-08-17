import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Globe, MoreHorizontal, Plus, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import type { DnsDomain, DnsRecord } from '@repo/api-client';
import { CreateDnsDomainSchema, CreateDnsRecordSchema } from '@repo/api-client';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@repo/ui/components/table';
import { FormInput } from '@repo/ui/form/form-input';
import { FormNumberInput } from '@repo/ui/form/form-number-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { formatShortDate } from '@repo/utils';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/dns/domains')({
  staticData: { breadcrumb: 'Domains' },
  component: DnsDomainsPage,
});

function domainQueryKey(zoneId: string) {
  return ['zone', zoneId, 'dns-domains'];
}

function recordQueryKey(zoneId: string, domainId: string) {
  return ['zone', zoneId, 'dns-domains', domainId, 'records'];
}

function DnsDomainsPage() {
  const { zoneId } = Route.useParams();
  useDocumentTitle('DNS Domains');

  const [createOpen, setCreateOpen] = useState(false);
  const [deletingDomain, setDeletingDomain] = useState<DnsDomain | null>(null);
  const [expandedDomainId, setExpandedDomainId] = useState<string | null>(null);

  const { data, isPending } = tsr.listDnsDomains.useQuery({
    queryKey: domainQueryKey(zoneId),
    queryData: { params: { zoneId } },
  });

  const domains = data?.status === 200 ? data.body : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/dcim/zones/$zoneId" params={{ zoneId }} className="text-muted-foreground hover:text-foreground">
          Zone
        </Link>
        <span className="text-muted-foreground">/</span>
        <span>DNS Domains</span>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>DNS Domains</CardTitle>
              <CardDescription>Manage forward and reverse DNS domains for this zone.</CardDescription>
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Domain
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : domains.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Globe className="text-muted-foreground mb-4 h-12 w-12" />
              <h3 className="text-lg font-medium">No DNS Domains</h3>
              <p className="text-muted-foreground mt-1 max-w-sm text-sm">
                Create a DNS domain to manage records for this zone.
              </p>
              <Button className="mt-4" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add First Domain
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((domain) => (
                  <DomainRow
                    key={domain.id}
                    domain={domain}
                    isExpanded={expandedDomainId === domain.id}
                    onToggleExpand={() => setExpandedDomainId(expandedDomainId === domain.id ? null : domain.id)}
                    onDelete={() => setDeletingDomain(domain)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {expandedDomainId && (
        <DomainRecordsCard
          zoneId={zoneId}
          domainId={expandedDomainId}
          domainName={domains.find((d) => d.id === expandedDomainId)?.name ?? ''}
        />
      )}

      <CreateDomainDialog zoneId={zoneId} open={createOpen} onOpenChange={setCreateOpen} />

      {deletingDomain && (
        <DeleteDomainDialog
          zoneId={zoneId}
          domain={deletingDomain}
          open={true}
          onOpenChange={(open) => {
            if (!open) setDeletingDomain(null);
          }}
          onDeleted={() => {
            if (expandedDomainId === deletingDomain.id) {
              setExpandedDomainId(null);
            }
          }}
        />
      )}
    </div>
  );
}

function DomainRow({
  domain,
  isExpanded,
  onToggleExpand,
  onDelete,
}: {
  domain: DnsDomain;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onDelete: () => void;
}) {
  return (
    <TableRow className={isExpanded ? 'bg-muted/50' : 'hover:bg-muted/30 cursor-pointer'} onClick={onToggleExpand}>
      <TableCell className="font-mono font-medium">{domain.name}</TableCell>
      <TableCell>
        <Badge variant={domain.type === 'FORWARD' ? 'default' : 'secondary'}>{domain.type}</Badge>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">{formatShortDate(domain.createdAt)}</TableCell>
      <TableCell>
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onDelete}>
                <Trash2 className="text-destructive mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
}

function CreateDomainDialog({
  zoneId,
  open,
  onOpenChange,
}: {
  zoneId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const form = useForm({
    resolver: zodResolver(CreateDnsDomainSchema),
    defaultValues: { name: '', type: 'FORWARD' },
  });

  const { mutateAsync: createDomain, isPending } = tsr.createDnsDomain.useMutation({
    meta: { successMessage: 'Domain created' },
  });

  const onSubmit = form.handleSubmit(async (data) => {
    await createDomain({
      params: { zoneId },
      body: data,
    });

    await queryClient.invalidateQueries({ queryKey: domainQueryKey(zoneId) });
    form.reset();
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Add DNS Domain</DialogTitle>
            <DialogDescription>Create a new DNS domain for this zone.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <FormInput control={form.control} name="name" label="Domain Name" placeholder="example.lan" autoFocus />
            <FormSelect
              control={form.control}
              name="type"
              label="Type"
              options={
                [
                  { label: 'Forward', value: 'FORWARD' },
                  { label: 'Reverse', value: 'REVERSE' },
                ] as const
              }
              placeholder="Select type"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <FormSubmitButton pending={isPending}>Create Domain</FormSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDomainDialog({
  zoneId,
  domain,
  open,
  onOpenChange,
  onDeleted,
}: {
  zoneId: string;
  domain: DnsDomain;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const queryClient = useQueryClient();

  const { mutateAsync: deleteDomain, isPending } = tsr.deleteDnsDomain.useMutation({
    meta: { successMessage: 'Domain deleted' },
  });

  const onDelete = async () => {
    await deleteDomain({
      params: { zoneId, domainId: domain.id },
    });

    await queryClient.invalidateQueries({ queryKey: domainQueryKey(zoneId) });
    onDeleted?.();
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-[425px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Domain: {domain.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{domain.name}</strong> and all of its DNS records? This action
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Domain'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DomainRecordsCard({ zoneId, domainId, domainName }: { zoneId: string; domainId: string; domainName: string }) {
  const [createRecordOpen, setCreateRecordOpen] = useState(false);
  const [deletingRecord, setDeletingRecord] = useState<DnsRecord | null>(null);

  const { data, isPending } = tsr.listDnsRecords.useQuery({
    queryKey: recordQueryKey(zoneId, domainId),
    queryData: { params: { zoneId, domainId }, query: {} },
  });

  const loadFailed = !isPending && (!data || data.status !== 200);
  const records = data?.status === 200 ? data.body : [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>
              Records <span className="text-muted-foreground font-mono text-base font-normal">({domainName})</span>
            </CardTitle>
            <CardDescription>DNS records for this domain. Auto-derived records are read-only.</CardDescription>
          </div>
          <Button onClick={() => setCreateRecordOpen(true)} size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Add Record
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : loadFailed ? (
          <p className="text-destructive text-sm">Failed to load records.</p>
        ) : records.length === 0 ? (
          <p className="text-muted-foreground text-sm">No DNS records for this domain.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>TTL Override</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record) => (
                <TableRow key={record.id}>
                  <TableCell className="font-mono">{record.name}</TableCell>
                  <TableCell>
                    <Badge variant={record.type === 'A' ? 'default' : record.type === 'AAAA' ? 'secondary' : 'outline'}>
                      {record.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono">{record.value}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={record.source === 'AUTO' ? 'secondary' : 'outline'}>{record.source}</Badge>
                      {record.source === 'AUTO' && record.deviceId && record.deviceRole === 'Server' && (
                        <Link
                          to="/dcim/servers/$deviceId"
                          params={{ deviceId: record.deviceId }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Server className="h-3.5 w-3.5" />
                        </Link>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {record.ttlOverride !== null ? (
                      `${record.ttlOverride}s`
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {record.source === 'MANUAL' && (
                      <div className="flex justify-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setDeletingRecord(record)}>
                              <Trash2 className="text-destructive mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <CreateRecordDialog
        zoneId={zoneId}
        domainId={domainId}
        open={createRecordOpen}
        onOpenChange={setCreateRecordOpen}
      />

      {deletingRecord && (
        <DeleteRecordDialog
          zoneId={zoneId}
          domainId={domainId}
          record={deletingRecord}
          open={true}
          onOpenChange={(open) => {
            if (!open) setDeletingRecord(null);
          }}
        />
      )}
    </Card>
  );
}

function CreateRecordDialog({
  zoneId,
  domainId,
  open,
  onOpenChange,
}: {
  zoneId: string;
  domainId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const form = useForm({
    resolver: zodResolver(CreateDnsRecordSchema),
    defaultValues: { name: '', type: 'A', value: '', ttlOverride: null },
  });

  const { mutateAsync: createRecord, isPending } = tsr.createDnsRecord.useMutation({
    meta: { successMessage: 'Record created' },
  });

  const onSubmit = form.handleSubmit(async (data) => {
    await createRecord({
      params: { zoneId, domainId },
      body: data,
    });

    await queryClient.invalidateQueries({ queryKey: recordQueryKey(zoneId, domainId) });
    form.reset();
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Add DNS Record</DialogTitle>
            <DialogDescription>Create a new manual DNS record.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <FormInput control={form.control} name="name" label="Name" placeholder="host1" autoFocus />
            <FormSelect
              control={form.control}
              name="type"
              label="Type"
              options={
                [
                  { label: 'A', value: 'A' },
                  { label: 'AAAA', value: 'AAAA' },
                  { label: 'PTR', value: 'PTR' },
                ] as const
              }
              placeholder="Select type"
            />
            <FormInput control={form.control} name="value" label="Value" placeholder="10.0.0.1" />
            <FormNumberInput
              control={form.control}
              name="ttlOverride"
              label="TTL Override"
              placeholder="Leave blank to inherit zone default"
              min={1}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <FormSubmitButton pending={isPending}>Create Record</FormSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRecordDialog({
  zoneId,
  domainId,
  record,
  open,
  onOpenChange,
}: {
  zoneId: string;
  domainId: string;
  record: DnsRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const { mutateAsync: deleteRecord, isPending } = tsr.deleteDnsRecord.useMutation({
    meta: { successMessage: 'Record deleted' },
  });

  const onDelete = async () => {
    await deleteRecord({
      params: { zoneId, domainId, recordId: record.id },
    });

    await queryClient.invalidateQueries({ queryKey: recordQueryKey(zoneId, domainId) });
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-[425px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Record</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete the <strong>{record.type}</strong> record{' '}
            <strong className="font-mono">{record.name}</strong> pointing to{' '}
            <strong className="font-mono">{record.value}</strong>?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Record'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
