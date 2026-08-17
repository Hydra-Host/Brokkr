import type { ZoneRedisCredential } from '@repo/api-client';
import { AlertTriangle, Check, Clipboard } from 'lucide-react';
import { useCopyToClipboard } from '../hooks/use-copy-to-clipboard';
import { Alert, AlertDescription, AlertTitle } from './alert';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';

export function ZoneRedisCredentialDialog({
  credential,
  onClose,
}: {
  credential: ZoneRedisCredential | null;
  onClose: () => void;
}) {
  const { copy, copiedKey, reset } = useCopyToClipboard();
  const urlTemplate = credential ? `redis://${credential.username}:${credential.password}@YOUR_REDIS_HOST:6379` : '';

  return (
    <Dialog
      open={credential !== null}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Zone Redis credential</DialogTitle>
          <DialogDescription>
            Configure the zone&apos;s bridge with this credential via <code>REDIS_URL</code>. Access is scoped to this
            zone&apos;s key namespace.
          </DialogDescription>
        </DialogHeader>

        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>This is the only time you&apos;ll see this password.</AlertTitle>
          <AlertDescription>
            Store it securely — it cannot be retrieved again, only rotated (which revokes the old one).
          </AlertDescription>
        </Alert>

        {credential && (
          <div className="space-y-3">
            <CredentialRow
              label="Username"
              value={credential.username}
              copied={copiedKey === 'username'}
              onCopy={() => void copy(credential.username, 'username')}
            />
            <CredentialRow
              label="Password"
              value={credential.password}
              copied={copiedKey === 'password'}
              onCopy={() => void copy(credential.password, 'password')}
            />
            <CredentialRow
              label="REDIS_URL (replace YOUR_REDIS_HOST)"
              value={urlTemplate}
              copied={copiedKey === 'url'}
              onCopy={() => void copy(urlTemplate, 'url')}
            />
          </div>
        )}

        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CredentialRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-1 text-xs font-medium">{label}</div>
      <div className="flex items-center gap-2">
        <pre className="bg-muted text-muted-foreground flex-1 overflow-x-auto rounded-md p-3 font-mono text-xs break-all whitespace-pre-wrap select-all">
          {value}
        </pre>
        <Button variant="outline" size="sm" onClick={onCopy} className="shrink-0 gap-2">
          {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
