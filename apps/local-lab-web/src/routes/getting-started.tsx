import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, FileText } from 'lucide-react';

import { MarkdownDoc } from '@/components/markdown-doc';
import { tsr } from '@/lib/api';

function GettingStartedPage() {
  const q = tsr.getGettingStarted.useQuery({ queryKey: ['getting-started'] });
  const body = q.data?.status === 200 ? q.data.body : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-5 font-mono">
      <div className="flex items-center gap-2">
        <FileText className="text-accent size-5" />
        <h1 className="text-text-primary text-xl font-bold tracking-tight">Get started - self hosting</h1>
      </div>

      {q.isLoading && <p className="text-text-muted text-sm">Loading guide…</p>}

      {q.isError && (
        <div className="border-status-offline/40 bg-bg-secondary text-text-muted rounded-sm border px-4 py-3 text-sm">
          Couldn't load the guide. Is the control-center API running?
        </div>
      )}

      {body && (
        <>
          {!body.found && (
            <div className="border-status-warning/40 bg-bg-secondary text-text-muted flex items-start gap-2 rounded-sm border px-3 py-2 text-xs">
              <AlertTriangle className="text-status-warning mt-0.5 size-3.5 shrink-0" />
              <span>
                Showing a placeholder — no <code className="text-accent">wiki/getting-started.md</code> was found in the
                hub repo (<code className="text-accent">HUB_REPO_PATH</code>). Point{' '}
                <code className="text-accent">HUB_REPO_PATH</code> at a checkout that has it (e.g.{' '}
                <code className="text-accent">@feat/boss</code>).
              </span>
            </div>
          )}
          <MarkdownDoc markdown={body.markdown} />
          <footer className="border-border-dim text-text-dim border-t pt-3 text-[11px]">
            {body.found ? (
              <>
                Rendered live from <code className="text-text-muted">{body.source}</code>.
              </>
            ) : (
              'Bundled placeholder.'
            )}
          </footer>
        </>
      )}
    </div>
  );
}

export const Route = createFileRoute('/getting-started')({ component: GettingStartedPage });
