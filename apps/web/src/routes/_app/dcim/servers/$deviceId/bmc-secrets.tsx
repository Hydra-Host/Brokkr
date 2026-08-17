import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { Check, Copy, Eye, EyeOff, Loader2, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { Server } from '@repo/api-client';
import { Alert, AlertDescription } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@repo/ui/components/select';
import { Switch } from '@repo/ui/components/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@repo/ui/components/table';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useCopyToClipboard } from '@repo/ui/hooks/use-copy-to-clipboard';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { DecommissionedServerOverlay } from '~/components/decommissioned-server-overlay';
import { tsr } from '~/lib/api';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');
const PURPOSE = 'BMC' as const;
const MASK = '••••••••••••';

const FIELDS = [
  { key: 'bmc_user', valueKey: 'user', label: 'username' },
  { key: 'bmc_pass', valueKey: 'pass', label: 'password' },
] as const;

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/bmc-secrets')({
  staticData: { breadcrumb: 'BMC Secrets' },
  component: BmcSecretsPage,
});

const writeSchema = z.object({
  user: z.string().min(1, 'Username is required'),
  pass: z.string().min(1, 'Password is required'),
});
type WriteForm = z.infer<typeof writeSchema>;

interface VersionMeta {
  version: number;
  purpose: string;
  kind: string;
  createdAt: string;
  createdBy: string;
  invalidatedAt: string | null;
}

function BmcSecretsPage() {
  const device = parentRoute.useLoaderData() as Server;
  const { deviceId } = Route.useParams();
  useDocumentTitle('BMC Secrets');

  const versionsQuery = tsr.listDeviceSecretVersions.useQuery({
    queryKey: ['server', deviceId, 'secret-versions'],
    queryData: { params: { deviceId } },
  });
  const versions = (versionsQuery.data?.status === 200 ? versionsQuery.data.body : []).filter(
    (v) => v.purpose === PURPOSE,
  );

  return (
    <div className="relative space-y-6">
      <DecommissionedServerOverlay deletedAt={device.deletedAt} />
      <BmcCredentialsCard
        deviceId={deviceId}
        versions={versions}
        isPending={versionsQuery.isPending}
        onChanged={() => void versionsQuery.refetch()}
      />
    </div>
  );
}

function BmcCredentialsCard({
  deviceId,
  versions,
  isPending,
  onChanged,
}: {
  deviceId: string;
  versions: VersionMeta[];
  isPending: boolean;
  onChanged: () => void;
}) {
  const current = versions.find((v) => v.invalidatedAt === null) ?? null;
  const [picked, setPicked] = useState<number | null>(null);
  const [asJson, setAsJson] = useState(false);
  const [creating, setCreating] = useState(false);

  const selectedVersion = picked ?? current?.version ?? versions[0]?.version ?? null;
  const selected = versions.find((v) => v.version === selectedVersion) ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>BMC Credentials</CardTitle>
        <CardDescription>IPMI/BMC username and password for this device.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={asJson} onCheckedChange={setAsJson} aria-label="Toggle JSON view" />
            <span className={asJson ? 'font-medium' : 'text-muted-foreground'}>JSON</span>
          </label>
          <div className="flex items-center gap-2">
            {versions.length > 0 && (
              <Select
                value={selectedVersion === null ? undefined : String(selectedVersion)}
                onValueChange={(v) => setPicked(Number.parseInt(v, 10))}
              >
                <SelectTrigger className="h-8 min-w-32">
                  <SelectValue placeholder="Version" />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((v) => (
                    <SelectItem key={v.version} value={String(v.version)}>
                      Version {v.version}
                      {v.version === current?.version ? ' (current)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button variant="default" size="sm" onClick={() => setCreating((c) => !c)}>
              <Plus className="mr-1 h-4 w-4" />
              Create new version
            </Button>
          </div>
        </div>

        {creating && (
          <CreateVersionForm
            deviceId={deviceId}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              setPicked(null);
              onChanged();
            }}
          />
        )}

        {isPending ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : selected === null ? (
          <p className="text-muted-foreground text-sm">No credentials stored yet.</p>
        ) : (
          <SecretView
            deviceId={deviceId}
            meta={selected}
            isCurrent={selected.version === current?.version}
            asJson={asJson}
            onInvalidated={onChanged}
          />
        )}
      </CardContent>
    </Card>
  );
}

function SecretView({
  deviceId,
  meta,
  isCurrent,
  asJson,
  onInvalidated,
}: {
  deviceId: string;
  meta: VersionMeta;
  isCurrent: boolean;
  asJson: boolean;
  onInvalidated: () => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const { mutateAsync: requestReveal, isPending: isRequesting } = tsr.requestDeviceSecretReveal.useMutation();

  useEffect(() => {
    setActive(null);
    setShown(new Set());
    setError(null);
    setTimedOut(false);
  }, [meta.version]);

  useEffect(() => {
    if (active === null) return;
    const timer = setTimeout(() => setTimedOut(true), 30_000);
    return () => clearTimeout(timer);
  }, [active]);

  const statusQuery = tsr.getDeviceSecretRevealStatus.useQuery({
    queryKey: ['server', deviceId, 'secret-reveal', active ?? 'none'],
    queryData: { params: { deviceId, requestId: active ?? '' } },
    enabled: active !== null && !timedOut,
    refetchInterval: (query) => (!timedOut && query.state.data?.body?.status === 'pending' ? 1500 : false),
  });

  const status = statusQuery.data?.status === 200 ? statusQuery.data.body : null;
  const secret = status?.status === 'ready' ? status.secret : null;
  const failed = timedOut || status?.status === 'unavailable';
  const revealing = active !== null && !failed && secret === null;
  const invalidated = meta.invalidatedAt !== null;

  async function ensureRevealed(): Promise<void> {
    if (invalidated || secret !== null) return;
    if (active !== null && !failed) return;
    setError(null);
    setTimedOut(false);
    const res = await requestReveal({ params: { deviceId, purpose: PURPOSE, version: meta.version }, body: {} });
    if (res.status === 202) {
      setActive(res.body.requestId);
    } else if (res.status === 409) {
      setError('This version was sealed to a superseded bridge key and cannot be revealed.');
      onInvalidated();
    } else {
      setError(`Could not start reveal for version ${meta.version}.`);
    }
  }

  function toggleField(field: string) {
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
    void ensureRevealed();
  }

  function valueFor(valueKey: string): string | undefined {
    return secret?.[valueKey];
  }

  return (
    <div className="space-y-3">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
        <span>
          Version {meta.version} created {new Date(meta.createdAt).toLocaleString()} · {meta.createdBy}
        </span>
        {isCurrent && <Badge variant="secondary">current</Badge>}
        {invalidated && <Badge variant="destructive">needs re-entry</Badge>}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>
            Reveal unavailable — the bridge may be offline or the request expired. Click reveal to retry.
          </AlertDescription>
        </Alert>
      )}
      {invalidated && (
        <Alert variant="destructive">
          <AlertDescription>
            This version was sealed to a superseded bridge key and cannot be revealed — create a new version.
          </AlertDescription>
        </Alert>
      )}

      {asJson ? (
        <JsonView
          key={meta.version}
          fields={FIELDS}
          secret={secret}
          revealing={revealing}
          disabled={invalidated}
          onReveal={ensureRevealed}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-1/3">Key</TableHead>
              <TableHead>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {FIELDS.map((f) => {
              const isShown = shown.has(f.key);
              const value = valueFor(f.valueKey);
              return (
                <TableRow key={f.key}>
                  <TableCell className="font-medium">{f.key}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <CopyButton value={value} disabled={invalidated} onNeedReveal={ensureRevealed} />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={invalidated || (isRequesting && active === null)}
                        title={isShown ? 'Hide' : 'Reveal'}
                        onClick={() => toggleField(f.key)}
                      >
                        {isShown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                      <span className="font-mono text-sm">
                        {isShown && revealing ? (
                          <span className="text-muted-foreground inline-flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" /> Revealing…
                          </span>
                        ) : isShown && value !== undefined ? (
                          value
                        ) : (
                          MASK
                        )}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function JsonView({
  fields,
  secret,
  revealing,
  disabled,
  onReveal,
}: {
  fields: readonly { key: string; valueKey: string }[];
  secret: Record<string, string> | null;
  revealing: boolean;
  disabled: boolean;
  onReveal: () => void;
}) {
  const [shown, setShown] = useState(false);
  const body = fields.reduce<Record<string, string>>((acc, f) => {
    acc[f.key] = shown && secret ? (secret[f.valueKey] ?? '') : MASK;
    return acc;
  }, {});
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => {
          setShown((s) => !s);
          onReveal();
        }}
      >
        {shown ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
        {shown && revealing ? 'Revealing…' : shown ? 'Hide' : 'Reveal'}
      </Button>
      <pre className="bg-muted/40 overflow-x-auto rounded-md p-3 font-mono text-sm">
        {JSON.stringify(body, null, 2)}
      </pre>
    </div>
  );
}

function CopyButton({
  value,
  disabled,
  onNeedReveal,
}: {
  value: string | undefined;
  disabled: boolean;
  onNeedReveal: () => void;
}) {
  const { copy, copied } = useCopyToClipboard();
  function handleCopy() {
    if (value === undefined) {
      onNeedReveal();
      return;
    }
    void copy(value);
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      disabled={disabled}
      title={value === undefined ? 'Reveal first to copy' : 'Copy'}
      onClick={handleCopy}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

function CreateVersionForm({
  deviceId,
  onCancel,
  onSaved,
}: {
  deviceId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<WriteForm>({ resolver: zodResolver(writeSchema), defaultValues: { user: '', pass: '' } });
  const { mutateAsync: write, isPending } = tsr.writeDeviceSecret.useMutation();

  async function onSubmit(values: WriteForm) {
    setError(null);
    const res = await write({ params: { deviceId }, body: { purpose: PURPOSE, kind: 'USER', secret: values } });
    if (res.status === 201) {
      form.reset();
      onSaved();
    } else if (res.status === 409) {
      setError('The device’s data center is not enrolled yet — its bridge key is required to seal secrets.');
    } else {
      setError('Failed to save the credential.');
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="bg-muted/30 space-y-3 rounded-md border p-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <FormInput control={form.control} name="user" label="Username" autoComplete="off" />
      <FormInput control={form.control} name="pass" label="Password" type="password" autoComplete="new-password" />
      <div className="flex gap-2">
        <FormSubmitButton pending={isPending}>Save new version</FormSubmitButton>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
