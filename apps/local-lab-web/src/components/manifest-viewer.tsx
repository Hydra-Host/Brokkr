import { type LayersManifestGroup } from '@repo/local-lab-contract';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { ConsoleControls, SectionHeading, wrapClass } from '@/components/console';
import { streamPaths } from '@/contract';
import { tsr } from '@/lib/api';
import { bodyError, errorMessage } from '@/lib/errors';
import { useLogStream, usePaintedHtml } from '@/lib/use-log-stream';
import { usePoll } from '@/lib/use-poll';

interface Agg {
  name: string;
  display: string;
  version?: string | null;
  kind: string;
  arches: Set<string>;
  distros: Set<string>;
  size: number;
  reqByGroup: Map<string, Set<string>>;
}

const DEFAULT_URL = '';
const KIND_DOT: Record<string, string> = {
  base: 'bg-accent',
  component: 'bg-status-online',
  legacy: 'bg-status-warning',
};

function fmtSize(bytes: number): string {
  if (!bytes) return '—';
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function Chip({ children, tone = 'white' }: { children: ReactNode; tone?: 'white' | 'sky' | 'violet' }) {
  const c =
    tone === 'sky'
      ? 'border-accent/30 text-accent/90'
      : tone === 'violet'
        ? 'border-status-purple/30 text-status-purple/90'
        : 'border-border-dim text-text-muted';
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${c}`}>{children}</span>;
}

export function ManifestViewer() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [submittedUrl, setSubmittedUrl] = useState('');
  const [arch, setArch] = useState<'all' | string>('all');
  const [distro, setDistro] = useState<'all' | string>('all');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [consoleTitle, setConsoleTitle] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seedWrap, setSeedWrap] = useState(true);
  const [primes, setPrimes] = useState<{ sha: string; runId: string; label: string }[]>([]);

  const seed = tsr.seedManifest.useMutation();
  const prime = tsr.primeBlob.useMutation();
  const nuke = tsr.nukeBlob.useMutation();
  const manifestQ = tsr.getLayersManifest.useQuery({
    queryKey: ['layers-manifest', submittedUrl],
    queryData: { query: { url: submittedUrl } },
    enabled: !!submittedUrl,
    retry: false,
  });
  const m = manifestQ.data?.status === 200 ? manifestQ.data.body.doc : null;
  const resolvedUrl = manifestQ.data?.status === 200 ? manifestQ.data.body.resolvedUrl : null;
  const loading = manifestQ.isFetching;
  const err =
    manifestQ.data && manifestQ.data.status !== 200
      ? (bodyError(manifestQ.data.body) ?? `request failed (${manifestQ.data.status})`)
      : (errorMessage(manifestQ.error) ?? '');
  const banner = seedError ?? err;
  const cache = tsr.getLayerCache.useQuery({ queryKey: ['layer-cache'], refetchInterval: usePoll(m ? 5000 : false) });
  const defaultUrl = tsr.getLayersDefaultUrl.useQuery({ queryKey: ['layers-default-url'] });
  const cachedSet = useMemo(() => new Set(cache.data?.status === 200 ? cache.data.body.shas : []), [cache.data]);
  const stream = useLogStream();
  const seedPaintRef = usePaintedHtml(stream.logRef, stream.logHtml || 'running…');

  const doPrime = (sha: string, label: string) =>
    prime.mutate(
      { body: { sha } },
      {
        onSuccess: (res) => {
          if (res.status === 200) {
            const runId = res.body.runId;
            setPrimes((p) => [...p.filter((x) => x.sha !== sha), { sha, runId, label }]);
          }
        },
      },
    );
  const doNuke = (sha: string) => nuke.mutate({ body: { sha } }, { onSuccess: () => void cache.refetch() });

  const seeded = useRef(false);
  useEffect(() => {
    const u = defaultUrl.data?.status === 200 ? defaultUrl.data.body.url : '';
    if (!u || seeded.current || url) return;
    seeded.current = true;
    setUrl(u);
    setSubmittedUrl(u);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultUrl.data]);

  const load = () => {
    if (!url) return;
    setSeedError(null);
    setOpen(null);
    setCollapsed({});
    if (url === submittedUrl) void manifestQ.refetch();
    else setSubmittedUrl(url);
    seed.mutate(
      { body: { url } },
      {
        onSuccess: (res) => {
          setConsoleTitle('Seed console');
          stream.open(streamPaths.run(res.body.runId));
        },
        onError: (e) => {
          setConsoleTitle(null);
          setSeedError(errorMessage(e) ?? 'seed failed');
        },
      },
    );
  };

  const groupName = useMemo(() => {
    const map: Record<string, LayersManifestGroup> = {};
    for (const g of m?.groups ?? []) map[g.slug] = g;
    return map;
  }, [m]);

  const arches = useMemo(() => [...new Set((m?.layers ?? []).map((l) => l.arch))].sort(), [m]);
  const distros = useMemo(
    () => [...new Set((m?.layers ?? []).map((l) => l.os_distro).filter(Boolean))].sort() as string[],
    [m],
  );

  const layers = useMemo(
    () =>
      (m?.layers ?? []).filter(
        (l) => (arch === 'all' || l.arch === arch) && (distro === 'all' || l.os_distro === distro),
      ),
    [m, arch, distro],
  );

  const grouped = useMemo(() => {
    const byGroup = new Map<string, Map<string, Agg>>();
    for (const l of layers) {
      const g = byGroup.get(l.group) ?? new Map<string, Agg>();
      byGroup.set(l.group, g);
      const a =
        g.get(l.name) ??
        ({
          name: l.name,
          display: l.display_name || l.name,
          version: l.version,
          kind: l.kind,
          arches: new Set(),
          distros: new Set(),
          size: l.size ?? 0,
          reqByGroup: new Map(),
        } as Agg);
      a.arches.add(l.arch);
      if (l.os_distro) a.distros.add(l.os_distro);
      for (const r of l.requires ?? []) {
        const set = a.reqByGroup.get(r.group) ?? new Set<string>();
        for (const dep of r.layers) set.add(dep);
        a.reqByGroup.set(r.group, set);
      }
      g.set(l.name, a);
    }
    return byGroup;
  }, [layers]);

  const requiredBy = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const l of layers)
      for (const req of l.requires ?? [])
        for (const dep of req.layers) {
          const s = map.get(dep) ?? new Set<string>();
          s.add(l.name);
          map.set(dep, s);
        }
    return map;
  }, [layers]);

  const totalSize = useMemo(() => layers.reduce((a, l) => a + (l.size ?? 0), 0), [layers]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
          placeholder="manifest or release-index URL"
          className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 min-w-[260px] flex-1 rounded border px-2 py-1.5 font-mono text-xs outline-none"
        />
        <button
          onClick={load}
          disabled={loading}
          className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {loading ? 'loading…' : 'Load'}
        </button>
      </div>
      {resolvedUrl && <p className="text-text-dim font-mono text-[10px]">resolved → {resolvedUrl}</p>}
      <p className="text-text-dim max-w-3xl text-[11px]">
        Loads an OS-layers release manifest (index or versioned) and visualizes its layer dependency graph. Fetched
        server-side (handles the asset host&apos;s UA + index→manifest follow).
      </p>
      {banner && <div className="text-status-offline text-sm">{banner}</div>}

      {consoleTitle && (
        <div className="space-y-1.5">
          <SectionHeading>{consoleTitle}</SectionHeading>
          <div className="relative">
            <ConsoleControls
              getText={() => stream.logRef.current?.textContent ?? ''}
              wrap={{ on: seedWrap, toggle: () => setSeedWrap((w) => !w) }}
              tail={{ on: stream.follow, toggle: () => stream.setFollow(!stream.follow) }}
            />
            <pre
              ref={seedPaintRef}
              className={`border-border-dim bg-bg-secondary text-text-primary max-h-56 overflow-auto rounded-lg border p-3 font-mono text-xs ${wrapClass(seedWrap)}`}
            />
          </div>
        </div>
      )}

      {primes.length > 0 && (
        <div className="space-y-3">
          {primes.map((p) => (
            <PrimeConsole
              key={p.sha}
              runId={p.runId}
              title={`Cache prime — ${p.label}`}
              onClose={() => setPrimes((cur) => cur.filter((x) => x.sha !== p.sha))}
            />
          ))}
        </div>
      )}

      {m && (
        <>
          <div className="border-border-dim bg-text-dim/[0.02] flex flex-wrap items-center gap-2 rounded-lg border p-3">
            <span className="text-text-primary font-mono text-sm font-semibold">{m.version ?? '?'}</span>
            <Chip tone="violet">{m.env ?? '?'}</Chip>
            <Chip>schema v{m.schema_version ?? '?'}</Chip>
            {m.generated_at && <Chip>{m.generated_at.replace('T', ' ').replace('Z', ' UTC')}</Chip>}
            {m.pipeline_id != null && <Chip>pipeline {m.pipeline_id}</Chip>}
            <span className="ml-auto flex gap-2">
              <Chip tone="sky">{layers.length} artifacts</Chip>
              <Chip tone="sky">{m.groups.length} groups</Chip>
              <Chip tone="sky">{fmtSize(totalSize)}</Chip>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <FilterRow label="arch" value={arch} options={['all', ...arches]} onChange={setArch} />
            <FilterRow label="distro" value={distro} options={['all', ...distros]} onChange={setDistro} />
          </div>

          <div className="space-y-2">
            {[...m.groups]
              .sort((a, b) => (a.slug === 'legacy' ? 1 : 0) - (b.slug === 'legacy' ? 1 : 0))
              .map((g) => {
                const entries = grouped.get(g.slug);
                if (!entries || entries.size === 0) return null;
                const isCollapsed = collapsed[g.slug];
                const rows = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
                return (
                  <div key={g.slug} className="border-border-dim bg-text-dim/[0.02] rounded-lg border">
                    <button
                      onClick={() => setCollapsed((c) => ({ ...c, [g.slug]: !c[g.slug] }))}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left"
                    >
                      <span className="text-text-dim text-xs">{isCollapsed ? '▸' : '▾'}</span>
                      <span className="text-text-primary text-sm">{g.name}</span>
                      <Chip>{g.selection_type === 'MULTI_SELECT' ? 'multi' : 'one'}</Chip>
                      <span className="text-text-dim ml-auto text-[11px]">{rows.length}</span>
                    </button>
                    {!isCollapsed && (
                      <div className="space-y-0.5 px-2 pb-2">
                        {rows.map((a) => {
                          const key = `${g.slug}/${a.name}`;
                          const isOpen = open === key;
                          const deps = [...a.reqByGroup.entries()]
                            .filter(([, s]) => s.size)
                            .map(([group, s]) => ({ group, layers: [...s].sort() }));
                          const rb = [...(requiredBy.get(a.name) ?? [])].sort();
                          const blobs = layers.filter((l) => l.group === g.slug && l.name === a.name);
                          return (
                            <div key={key} className="rounded-md">
                              <button
                                onClick={() => setOpen(isOpen ? null : key)}
                                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${isOpen ? 'bg-hover-bg' : 'hover:bg-hover-bg'}`}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full ${KIND_DOT[a.kind] ?? 'bg-text-dim'}`} />
                                <span className="text-text-primary font-mono">{a.name}</span>
                                {a.version && <span className="text-text-dim">{a.version}</span>}
                                <span className="ml-auto flex items-center gap-1">
                                  {[...a.arches].sort().map((x) => (
                                    <Chip key={x}>{x}</Chip>
                                  ))}
                                  {[...a.distros].sort().map((x) => (
                                    <Chip key={x}>{x}</Chip>
                                  ))}
                                  <span className="text-text-dim w-14 text-right">{fmtSize(a.size)}</span>
                                  <span className="text-text-label w-3 text-center">{isOpen ? '−' : '+'}</span>
                                </span>
                              </button>
                              {isOpen && (
                                <div className="border-border-dim my-1 ml-5 space-y-1.5 border-l pl-3 text-[11px]">
                                  {deps.map((r) => (
                                    <div key={r.group} className="flex flex-wrap items-baseline gap-1.5">
                                      <span className="text-status-warning/70">
                                        requires {groupName[r.group]?.name ?? r.group}:
                                      </span>
                                      <span className="text-text-dim">{r.layers.length > 1 ? 'one of' : ''}</span>
                                      {r.layers.map((dep) => (
                                        <button
                                          key={dep}
                                          onClick={() => {
                                            const tg = m.layers.find((l) => l.name === dep)?.group;
                                            if (tg) setOpen(`${tg}/${dep}`);
                                          }}
                                          className="text-accent/80 hover:text-accent font-mono underline decoration-dotted"
                                        >
                                          {dep}
                                        </button>
                                      ))}
                                    </div>
                                  ))}
                                  {rb.length > 0 && (
                                    <div className="flex flex-wrap items-baseline gap-1.5">
                                      <span className="text-status-online/70">required by:</span>
                                      {rb.map((dep) => (
                                        <span key={dep} className="text-text-muted font-mono">
                                          {dep}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  <div className="space-y-0.5 pt-0.5">
                                    <span className="text-text-dim">
                                      builds ({blobs.length}) — prime/nuke the nginx cache:
                                    </span>
                                    {blobs.map((b, bi) => {
                                      const cached = cachedSet.has(b.sha256 ?? '');
                                      const blobLabel =
                                        `${a.name} · ${b.os_distro}-${b.os_codename ?? ''} ${b.arch}`.trim();
                                      return (
                                        <div key={b.sha256 ?? bi} className="flex items-center gap-2">
                                          <button
                                            disabled={!b.sha256}
                                            onClick={() =>
                                              b.sha256 && (cached ? doNuke(b.sha256) : doPrime(b.sha256, blobLabel))
                                            }
                                            className={`w-12 rounded border px-2 py-0.5 text-center text-[10px] disabled:opacity-40 ${
                                              cached
                                                ? 'border-status-offline/40 text-status-offline/80 hover:bg-status-offline/10'
                                                : 'border-accent/40 text-accent/80 hover:bg-accent/10'
                                            }`}
                                          >
                                            {cached ? 'nuke' : 'pull'}
                                          </button>
                                          <span className="text-text-muted font-mono">
                                            {b.os_distro}-{b.os_codename ?? ''}
                                          </span>
                                          <Chip>{b.arch}</Chip>
                                          {b.variant && <Chip>{b.variant}</Chip>}
                                          <span className="text-text-dim">{fmtSize(b.size ?? 0)}</span>
                                          <span className="text-text-label ml-auto font-mono" title={b.sha256}>
                                            {(b.sha256 ?? '').slice(0, 10)}
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </>
      )}
    </div>
  );
}

function PrimeConsole({ runId, title, onClose }: { runId: string; title: string; onClose: () => void }) {
  const stream = useLogStream();
  const [wrap, setWrap] = useState(true);
  const primePaintRef = usePaintedHtml(stream.logRef, stream.logHtml || 'priming…');
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
          ref={primePaintRef}
          className={`border-border-dim bg-bg-secondary text-text-primary max-h-56 overflow-auto rounded-lg border p-3 font-mono text-xs ${wrapClass(wrap)}`}
        />
      </div>
    </div>
  );
}

function FilterRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-text-dim tracking-wide uppercase">{label}</span>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition ${
            value === o
              ? 'border-accent/50 bg-accent/10 text-accent'
              : 'border-border-dim text-text-muted hover:bg-hover-bg'
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
