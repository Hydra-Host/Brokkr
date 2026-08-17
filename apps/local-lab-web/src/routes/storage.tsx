import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { ConsoleControls, SectionHeading, SvcBtn, wrapClass } from '@/components/console';
import { healthUi } from '@/components/status/health-ui';
import { streamPaths, type StorageItem, type StorageVerifyResult, type WipeableCategoryId } from '@/contract';
import { tsr } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { fmtAgo, fmtBytes } from '@/lib/format';
import { useToast } from '@/lib/toast';
import { useLogStream, usePaintedHtml } from '@/lib/use-log-stream';

const WIPEABLE: readonly string[] = ['discovery-images', 'built-artifacts', 'boot-artifacts'];
function isWipeable(id: string): id is WipeableCategoryId {
  return WIPEABLE.includes(id);
}
function serverError(x: unknown): string | undefined {
  if (x === null || typeof x !== 'object') return undefined;
  if ('body' in x && x.body !== null && typeof x.body === 'object') {
    const fromBody = serverError(x.body);
    if (fromBody) return fromBody;
  }
  if ('message' in x && typeof x.message === 'string') return x.message;
  if ('error' in x && typeof x.error === 'string') return x.error;
  return undefined;
}

type VerifyStatus = StorageVerifyResult['results'][number]['status'];

function CopyPath({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  if (!path) return null;
  return (
    <button
      onClick={() => {
        void copyText(path).then((ok) => {
          if (ok) {
            setDone(true);
            setTimeout(() => setDone(false), 1000);
          }
        });
      }}
      title={path}
      className="text-text-dim hover:text-accent max-w-full truncate font-mono text-[10px]"
    >
      {done ? '✓ ' : '⧉ '}
      {path}
    </button>
  );
}

function ItemTable({
  items,
  verify,
  basePath,
}: {
  items?: StorageItem[];
  verify: Record<string, VerifyStatus>;
  basePath?: string;
}) {
  const list = items ?? [];
  if (list.length === 0) return <div className="text-text-dim px-3 py-1 text-[11px]">no files</div>;
  const baseDir = basePath || (list[0]?.path ? list[0].path.replace(/\/[^/]+$/, '') : '');
  return (
    <div className="space-y-1 px-3 py-2">
      {list.map((it) => {
        const dot = healthUi(it.present ? (it.served === false ? 'unhealthy' : 'up') : 'missing').dot;
        const vkey = `${it.arch ?? ''}/${it.name}`;
        const v = verify[vkey];
        return (
          <div key={vkey || it.name} className="flex items-center gap-2 text-[11px]">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="text-text-primary font-mono">{it.name}</span>
            {it.arch && <span className="text-text-dim">{it.arch}</span>}
            {it.present && it.served === false && <span className="text-status-offline">not served</span>}
            <span className="text-text-dim ml-auto shrink-0">{fmtBytes(it.sizeBytes)}</span>
            {it.sha256 && (
              <span className="text-text-label shrink-0 font-mono" title={it.sha256}>
                {it.sha256.slice(0, 10)}
              </span>
            )}
            {v && (
              <span
                className={`shrink-0 ${v === 'match' ? 'text-status-online' : v === 'stale' ? 'text-status-offline' : 'text-text-dim'}`}
              >
                {v}
              </span>
            )}
          </div>
        );
      })}
      {baseDir && (
        <div className="pt-1">
          <CopyPath path={baseDir} />
        </div>
      )}
    </div>
  );
}

function StreamConsole({ runId, title, onClose }: { runId: string; title: string; onClose: () => void }) {
  const stream = useLogStream();
  const [wrap, setWrap] = useState(true);
  const paintRef = usePaintedHtml(stream.logRef, stream.logHtml || 'running…');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => stream.open(streamPaths.run(runId)), [runId]);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <SectionHeading>{title}</SectionHeading>
        <button onClick={onClose} className="text-text-dim hover:text-text-primary text-xs" title="dismiss">
          ✕
        </button>
      </div>
      <div className="relative">
        <ConsoleControls
          getText={() => stream.logRef.current?.textContent ?? ''}
          wrap={{ on: wrap, toggle: () => setWrap((w) => !w) }}
          tail={{ on: stream.follow, toggle: () => stream.setFollow(!stream.follow) }}
        />
        <pre
          ref={paintRef}
          className={`border-border-dim bg-bg-secondary text-text-primary max-h-56 overflow-auto rounded-lg border p-3 font-mono text-xs ${wrapClass(wrap)}`}
        />
      </div>
    </div>
  );
}

function StoragePage() {
  const toast = useToast();
  const state = tsr.getStorageState.useQuery({ queryKey: ['storage-state'], refetchInterval: 3000 });
  const wipe = tsr.wipeStorage.useMutation();
  const resync = tsr.resyncStorage.useMutation();
  const verify = tsr.verifyStorage.useMutation();
  const [run, setRun] = useState<{ runId: string; title: string } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({ 'discovery-images': true });
  const [verifyMap, setVerifyMap] = useState<Record<string, VerifyStatus>>({});

  const body = state.data?.status === 200 ? state.data.body : null;
  const categories = body?.categories ?? [];
  // verify.isPending gates all three — a late verify onSuccess must not re-populate a verifyMap a concurrent wipe/resync just cleared.
  const busy = wipe.isPending || resync.isPending || verify.isPending;

  const doWipe = (id: WipeableCategoryId, label: string) => {
    if (!window.confirm(`Wipe ${label}? This deletes the on-disk files and forces a rebuild/re-sync.`)) return;
    wipe.mutate(
      { body: { category: id } },
      {
        onSuccess: (res) => {
          if (res.status === 200) {
            setVerifyMap({});
            setRun({ runId: res.body.runId, title: `wipe ${label}` });
          } else {
            toast.error(serverError(res.body) ?? `wipe ${label} failed`);
          }
          void state.refetch();
        },
        onError: (err) => toast.error(serverError(err) ?? `wipe ${label} failed`),
      },
    );
  };
  const doResync = () =>
    resync.mutate(
      { body: {} },
      {
        onSuccess: (res) => {
          if (res.status === 200) {
            setVerifyMap({});
            setRun({ runId: res.body.runId, title: 'resync discovery images' });
          } else {
            toast.error(serverError(res.body) ?? 'resync failed');
          }
        },
        onError: (err) => toast.error(serverError(err) ?? 'resync failed'),
      },
    );
  const doVerify = () =>
    verify.mutate(
      { body: {} },
      {
        onSuccess: (res) => {
          if (res.status === 200) {
            setVerifyMap(Object.fromEntries(res.body.results.map((r) => [`${r.arch}/${r.name}`, r.status])));
          } else {
            toast.error(serverError(res.body) ?? 'verify failed');
          }
        },
        onError: (err) => toast.error(serverError(err) ?? 'verify failed'),
      },
    );

  const p = body?.provenance;
  return (
    <div data-tour="storage-categories" className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <SectionHeading>Storage</SectionHeading>
          {body && <span className="text-text-dim font-mono text-[11px]">{fmtBytes(body.totalBytes ?? 0)} total</span>}
        </div>
        {p && (
          <div className="border-border-dim text-text-muted rounded-md border px-3 py-2 font-mono text-[11px]">
            brokkr-live-light <span className="text-text-primary">{p.version || '?'}</span> · {p.hostArch} · origin{' '}
            <span className="text-text-primary">{p.originHost || '?'}</span> · synced{' '}
            {p.lastSyncedMs > 0 ? fmtAgo(p.lastSyncedMs) : 'never'}
          </div>
        )}
        {body && !body.discoveryReachable && (
          <div className="border-border-dim text-text-dim rounded-md border px-3 py-2 text-[11px]">
            spoke unreachable — discovery status unknown (retrying…)
          </div>
        )}
        {body && p && body.discoveryReachable && !body.discoveryOk && (
          <div className="border-status-offline/40 bg-status-offline/10 text-status-offline flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-[11px]">
            <span>{p.hostArch} discovery images missing or not served → fleet will 404 at iPXE</span>
            <SvcBtn label="re-sync" disabled={busy} onClick={doResync} />
          </div>
        )}
        {categories.map((cat) => {
          const ui =
            cat.id === 'discovery-images'
              ? healthUi(!cat.present ? 'missing' : body?.discoveryReachable && !body?.discoveryOk ? 'unhealthy' : 'up')
              : healthUi(cat.present ? 'up' : 'missing');
          const wipeId = cat.wipeable && isWipeable(cat.id) ? cat.id : null;
          const isOpen = open[cat.id] ?? false;
          return (
            <div key={cat.id} className="border-border-dim rounded-md border text-sm">
              <button
                onClick={() => setOpen((o) => ({ ...o, [cat.id]: !isOpen }))}
                className="flex w-full items-center justify-between px-3 py-2 text-left"
              >
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${ui.dot}`} />
                  <span className="text-text-primary font-medium">{cat.label}</span>
                  <span className="text-text-dim text-[10px]">{isOpen ? '▾' : '▸'}</span>
                </span>
                <span className="text-text-dim font-mono text-[11px]">
                  {fmtBytes(cat.sizeBytes)} · {cat.fileCount} files
                </span>
              </button>
              {isOpen && <ItemTable items={cat.items} verify={verifyMap} basePath={cat.path} />}
              <div className="flex gap-1.5 px-3 pb-2 text-[11px]">
                {cat.id === 'discovery-images' && <SvcBtn label="re-sync" disabled={busy} onClick={doResync} />}
                {cat.id === 'discovery-images' && <SvcBtn label="verify shas" disabled={busy} onClick={doVerify} />}
                {wipeId && (
                  <SvcBtn
                    label="wipe"
                    danger
                    disabled={busy || (cat.id !== 'discovery-images' && !cat.present)}
                    onClick={() => doWipe(wipeId, cat.label)}
                  />
                )}
              </div>
            </div>
          );
        })}
        {!body && <div className="text-text-dim text-sm">loading…</div>}
      </div>
      <div>
        {run ? (
          <StreamConsole runId={run.runId} title={run.title} onClose={() => setRun(null)} />
        ) : (
          <div className="border-border-dim text-text-dim rounded-lg border border-dashed p-3 text-xs">
            Run a wipe or re-sync to stream its output here.
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/storage')({ component: StoragePage });
