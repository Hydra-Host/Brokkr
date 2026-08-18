import { createFileRoute } from '@tanstack/react-router';
import { BookOpen, ExternalLink } from 'lucide-react';

import { tsr } from '@/lib/api';

const GUIDE_PATH = '/docs/self-host/docker-compose';

function GettingStartedPage() {
  const q = tsr.listStacks.useQuery({ queryKey: ['stacks'] });
  const body = q.data?.status === 200 ? q.data.body : undefined;
  const self = body?.stacks.find((s) => s.slot === body.selfSlot);
  const guideUrl = self?.webUrl ? `${self.webUrl.replace(/\/+$/, '')}${GUIDE_PATH}` : null;
  const failed = q.isError || (q.data !== undefined && q.data.status !== 200);

  return (
    <div className="mx-auto max-w-3xl space-y-5 font-mono">
      <div className="flex items-center gap-2">
        <BookOpen className="text-accent size-5" />
        <h1 className="text-text-primary text-xl font-bold tracking-tight">Get started</h1>
      </div>

      <p className="text-text-muted text-sm">
        The self-hosting guide lives in the hub docs now. It covers Docker Compose bring-up of the hub and a bridge,
        TLS, zones and registration tokens, per-zone Redis ACLs, and the hardening checklist. It stays in one place
        instead of a second copy here.
      </p>

      {q.isLoading ? (
        <p className="text-text-muted text-sm">loading…</p>
      ) : failed ? (
        <p className="text-status-offline text-sm">Couldn't load the guide. Check that the hub API is reachable.</p>
      ) : guideUrl ? (
        <a
          href={guideUrl}
          target="_blank"
          rel="noreferrer"
          className="border-border-dim text-text-primary hover:bg-hover-bg inline-flex items-center gap-2 rounded border px-3 py-2 text-sm"
        >
          <ExternalLink className="size-4" />
          Open the self-hosting guide
        </a>
      ) : (
        <p className="text-text-muted text-sm">
          Bring the hub up, then open <code className="text-accent">{GUIDE_PATH}</code> on it.
        </p>
      )}
    </div>
  );
}

export const Route = createFileRoute('/getting-started')({ component: GettingStartedPage });
