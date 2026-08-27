import { createFileRoute } from '@tanstack/react-router';
import { AnsiUp } from 'ansi_up';
import { useEffect, useRef, useState } from 'react';

import { AnsiLogPane, SectionHeading } from '@/components/console';
import { TimelinePanel } from '@/components/timeline-panel';
import {
  downloadPaths,
  type ResultStatus,
  type Run,
  type TestResult,
  type TestResultAttachment,
  type TestResultCase,
  type TestResultStep,
} from '@/contract';
import { tsr } from '@/lib/api';
import { fetchLabText } from '@/lib/fetch-lab-text';
import { useTestRuns } from '@/lib/use-test-runs';

const STATUS_COLOR: Record<ResultStatus | Run['status'], string> = {
  running: 'text-status-warning',
  passed: 'text-status-online',
  failed: 'text-status-offline',
  broken: 'text-status-price',
  skipped: 'text-text-dim',
  unknown: 'text-text-dim',
  cancelled: 'text-text-dim',
  orphaned: 'text-status-warning',
};
const STATUS_DOT: Record<ResultStatus, string> = {
  passed: 'bg-status-online',
  failed: 'bg-status-offline',
  broken: 'bg-status-price',
  skipped: 'bg-text-dim',
  unknown: 'bg-text-dim',
};

function fmtDur(ms: number | null): string {
  if (ms == null) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ResultsPage() {
  const runs = useTestRuns();
  const runList = runs.data?.status === 200 ? runs.data.body : [];
  const purge = tsr.purgeTestRuns.useMutation();
  const [selected, setSelected] = useState<string | null>(null);
  const [att, setAtt] = useState<{ name: string; html: string } | null>(null);

  useEffect(() => {
    if (selected && runList.some((r) => r.runId === selected)) return;
    const first = runList[0];
    if (first) setSelected(first.runId);
  }, [runList, selected]);

  const selectedStatus = runList.find((r) => r.runId === selected)?.status;
  const result = tsr.getTestResult.useQuery({
    queryKey: ['test-result', selected],
    queryData: { params: { runId: selected ?? '' } },
    enabled: !!selected && selectedStatus !== 'running',
    retry: false,
  });
  const detail: TestResult | null = result.data?.status === 200 ? result.data.body : null;

  useEffect(() => {
    setAtt(null);
  }, [selected]);

  const openAtt = (a: TestResultAttachment) => {
    if (!selected) return;
    fetchLabText(downloadPaths.testAttachment(selected, a.source))
      .then((text) => {
        const ansi = new AnsiUp();
        ansi.use_classes = false;
        setAtt({ name: a.name, html: ansi.ansi_to_html(text) });
      })
      .catch(() => setAtt({ name: a.name, html: '[failed to load attachment]' }));
  };

  const selectedRun = runList.find((r) => r.runId === selected) ?? null;

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-[240px_minmax(0,1fr)_minmax(0,2fr)]">
        <div className="max-h-64 space-y-2 overflow-auto pr-1 lg:max-h-none lg:min-h-0">
          <div className="flex items-center justify-between">
            <SectionHeading>Test runs</SectionHeading>
            {runList.length > 0 && (
              <button
                onClick={() => {
                  if (!confirm('Purge ALL test results?')) return;
                  purge.mutate(
                    { body: {} },
                    {
                      onSuccess: () => {
                        setSelected(null);
                        void runs.refetch();
                      },
                    },
                  );
                }}
                className="text-status-offline/70 hover:text-status-offline text-[11px]"
              >
                purge all
              </button>
            )}
          </div>
          {runList.length === 0 && (
            <div className="text-text-dim text-xs">no test runs yet — launch one from Scenarios</div>
          )}
          {runList.map((r) => (
            <div key={r.runId} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <RunRow run={r} active={r.runId === selected} onClick={() => setSelected(r.runId)} />
              </div>
              <button
                title="Purge this run"
                onClick={() =>
                  purge.mutate(
                    { body: { runId: r.runId } },
                    {
                      onSuccess: () => {
                        if (selected === r.runId) {
                          setSelected(null);
                        }
                        void runs.refetch();
                      },
                    },
                  )
                }
                className="text-status-offline/50 hover:text-status-offline px-1 text-xs"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="flex flex-col pr-1 lg:min-h-0 lg:overflow-auto">
          <div className="mb-2 flex items-center gap-2">
            <SectionHeading>Result</SectionHeading>
            {selectedRun && <span className="text-text-dim font-mono text-xs">{selectedRun.label}</span>}
          </div>
          {!detail && selectedRun?.status === 'running' ? (
            <TimelinePanel runId={selected} isRunning />
          ) : detail ? (
            <div className="space-y-3">
              <SummaryBar summary={detail.summary} />
              {detail.runLogs.length > 0 && (
                <div className="space-y-1">
                  <div className="text-text-muted text-[11px] tracking-wide uppercase">
                    Run logs (this run's window)
                  </div>
                  <AttList atts={detail.runLogs} onAtt={openAtt} />
                </div>
              )}
              {detail.tests.length === 0 && <div className="text-text-dim text-sm">no test cases in this run.</div>}
              {detail.tests.map((t, i) => (
                <CaseCard key={i} c={t} onAtt={openAtt} />
              ))}
            </div>
          ) : (
            <div className="text-text-dim text-sm">{selectedRun ? 'loading…' : 'select a run with results.'}</div>
          )}
        </div>

        <div className="flex min-h-[55vh] flex-col lg:min-h-0">
          <div className="mb-2">
            <SectionHeading>Attachment{att ? `: ${att.name}` : ''}</SectionHeading>
          </div>
          {att ? (
            <AttachmentView html={att.html} />
          ) : (
            <div className="border-border-dim bg-bg-secondary text-text-dim flex flex-1 items-center justify-center rounded-lg border px-6 text-center text-sm">
              Click an attachment (serial console, timeline, stdout…) to view it here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryBar({ summary }: { summary: TestResult['summary'] }) {
  const items = [
    ['passed', summary.passed],
    ['failed', summary.failed],
    ['broken', summary.broken],
    ['skipped', summary.skipped],
  ] as const;
  return (
    <div className="flex flex-wrap gap-1.5 text-[11px]">
      <span className="border-border-dim text-text-muted rounded-full border px-2 py-0.5">total: {summary.total}</span>
      {items
        .filter(([, n]) => n > 0)
        .map(([k, n]) => (
          <span key={k} className={`border-border-dim rounded-full border px-2 py-0.5 ${STATUS_COLOR[k]}`}>
            {k}: {n}
          </span>
        ))}
    </div>
  );
}

function CaseCard({ c, onAtt }: { c: TestResultCase; onAtt: (a: TestResultAttachment) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-border-dim bg-text-dim/[0.02] rounded-lg border">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.status] ?? 'bg-text-dim'}`} />
        <span className="text-text-primary flex-1 truncate text-sm font-medium">{c.name}</span>
        <span className="text-text-dim font-mono text-[11px]">{fmtDur(c.durationMs)}</span>
        <span className={`text-[11px] ${STATUS_COLOR[c.status]}`}>{c.status}</span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          {c.message && (
            <pre className="border-status-offline/20 bg-status-offline/5 text-status-offline/90 max-h-40 overflow-auto rounded border p-2 text-[11px] whitespace-pre-wrap">
              {c.message}
              {c.trace ? `\n\n${c.trace}` : ''}
            </pre>
          )}
          {c.steps.map((s, i) => (
            <StepRow key={i} s={s} depth={0} onAtt={onAtt} />
          ))}
          {c.attachments.length > 0 && <AttList atts={c.attachments} onAtt={onAtt} />}
        </div>
      )}
    </div>
  );
}

function StepRow({ s, depth, onAtt }: { s: TestResultStep; depth: number; onAtt: (a: TestResultAttachment) => void }) {
  return (
    <div style={{ marginLeft: depth * 14 }} className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s.status] ?? 'bg-text-dim'}`} />
        <span className="text-text-primary flex-1 truncate">{s.name}</span>
        <span className="text-text-dim font-mono text-[10px]">{fmtDur(s.durationMs)}</span>
      </div>
      {s.attachments.length > 0 && (
        <div className="ml-3.5">
          <AttList atts={s.attachments} onAtt={onAtt} />
        </div>
      )}
      {s.steps.map((c, i) => (
        <StepRow key={i} s={c} depth={depth + 1} onAtt={onAtt} />
      ))}
    </div>
  );
}

function AttList({ atts, onAtt }: { atts: TestResultAttachment[]; onAtt: (a: TestResultAttachment) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {atts.map((a, i) => (
        <button
          key={i}
          onClick={() => onAtt(a)}
          className="border-accent/30 text-accent/90 hover:bg-accent/10 rounded border px-2 py-0.5 font-mono text-[11px]"
        >
          {a.name}
        </button>
      ))}
    </div>
  );
}

function AttachmentView({ html }: { html: string }) {
  const ref = useRef<HTMLPreElement>(null);
  return <AnsiLogPane logHtml={html} logRef={ref} placeholder="" />;
}

function RunRow({ run, active, onClick }: { run: Run; active: boolean; onClick: () => void }) {
  const duration = run.finishedAt === null ? null : run.finishedAt - run.startedAt;
  return (
    <button
      onClick={onClick}
      className={[
        'w-full rounded-md border px-3 py-2 text-left text-sm transition',
        active ? 'border-accent/50 bg-accent/5' : 'border-border-dim hover:bg-hover-bg',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <span className="text-text-primary truncate font-medium" title={run.opId}>
          {run.label}
        </span>
        <span className={`text-xs ${STATUS_COLOR[run.status]}`}>{run.status}</span>
      </div>
      <div className="text-text-dim mt-0.5 flex items-center justify-between text-[11px]">
        <span>
          {fmtTime(run.startedAt)}
          {duration === null ? '' : ` · ${fmtDur(duration)}`}
        </span>
        <span>{run.hasResult ? 'results' : run.status === 'running' ? 'running…' : 'no results'}</span>
      </div>
    </button>
  );
}

export const Route = createFileRoute('/results')({ component: ResultsPage });
