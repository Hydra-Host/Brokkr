import { Check, Copy } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { cn } from '../utils';
import { useApiMonitor, type ApiCall } from './use-api-monitor';

interface ApiPanelProps {
  className?: string;
}

function formatJson(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return data;
    }
  }
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function formatCallForCopy(call: ApiCall): string {
  const parts: string[] = [];
  parts.push(`${call.method} ${call.url}`);
  parts.push(`Status: ${call.responseStatus || 'pending'}`);
  if (call.duration !== undefined) parts.push(`Duration: ${call.duration}ms`);
  parts.push('');
  parts.push('--- Request Headers ---');
  Object.entries(call.requestHeaders).forEach(([k, v]) => parts.push(`${k}: ${v}`));
  if (call.requestBody) {
    parts.push('');
    parts.push('--- Request Body ---');
    parts.push(formatJson(call.requestBody));
  }
  if (call.responseHeaders) {
    parts.push('');
    parts.push('--- Response Headers ---');
    Object.entries(call.responseHeaders).forEach(([k, v]) => parts.push(`${k}: ${v}`));
  }
  if (call.responseBody) {
    parts.push('');
    parts.push('--- Response Body ---');
    parts.push(formatJson(call.responseBody));
  }
  if (call.error) {
    parts.push('');
    parts.push('--- Error ---');
    parts.push(call.error);
  }
  return parts.join('\n');
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'text-text-dim hover:bg-active-bg hover:text-text-primary rounded p-0.5 transition-colors',
        className,
      )}
      title="Copy"
    >
      {copied ? <Check className="text-accent h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: 'bg-status-online',
    POST: 'bg-blue-600',
    PUT: 'bg-amber-600',
    PATCH: 'bg-orange-600',
    DELETE: 'bg-status-offline',
  };
  return (
    <span
      className={cn('text-foreground rounded px-1.5 py-0.5 text-[10px] font-bold', colors[method] || 'bg-text-muted')}
    >
      {method}
    </span>
  );
}

function StatusBadge({ status }: { status?: number }) {
  if (!status) return <span className="text-text-dim">pending</span>;
  const isSuccess = status >= 200 && status < 300;
  const isClientError = status >= 400 && status < 500;
  const isServerError = status >= 500;
  return (
    <span
      className={cn(
        'font-mono text-xs',
        isSuccess && 'text-status-online',
        isClientError && 'text-status-warning',
        isServerError && 'text-status-offline',
        !isSuccess && !isClientError && !isServerError && 'text-text-muted',
      )}
    >
      {status}
    </span>
  );
}

function Section({ title, children, copyText }: { title: string; children: React.ReactNode; copyText?: string }) {
  return (
    <div className="flex flex-col">
      <div className="border-border bg-bg-secondary sticky top-0 z-10 flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-text-muted text-xs font-medium">{title}</span>
        {copyText && <CopyButton text={copyText} />}
      </div>
      <div className="overflow-auto p-3">{children}</div>
    </div>
  );
}

function CallDetail({ call }: { call: ApiCall }) {
  const [tab, setTab] = useState<'response' | 'request'>('response');

  const requestHeadersStr =
    Object.keys(call.requestHeaders).length > 0
      ? Object.entries(call.requestHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')
      : null;

  const responseHeadersStr =
    call.responseHeaders && Object.keys(call.responseHeaders).length > 0
      ? Object.entries(call.responseHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')
      : null;

  const responseBodyStr =
    call.responseBody !== undefined && call.responseBody !== null ? formatJson(call.responseBody) : null;

  const requestBodyStr =
    call.requestBody !== undefined && call.requestBody !== null ? formatJson(call.requestBody) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-border bg-bg-secondary flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <MethodBadge method={call.method} />
        <span className="text-text-primary flex-1 truncate text-xs">{call.path}</span>
        <StatusBadge status={call.responseStatus} />
        {call.duration !== undefined && <span className="text-text-dim text-xs">{call.duration}ms</span>}
      </div>

      <div className="border-border bg-bg-secondary/50 flex shrink-0 gap-1 border-b px-2 py-1">
        <button
          onClick={() => setTab('response')}
          className={cn(
            'rounded px-2 py-0.5 text-xs',
            tab === 'response' ? 'bg-active-bg text-accent' : 'text-text-muted hover:text-text-primary',
          )}
        >
          Response
        </button>
        <button
          onClick={() => setTab('request')}
          className={cn(
            'rounded px-2 py-0.5 text-xs',
            tab === 'request' ? 'bg-active-bg text-accent' : 'text-text-muted hover:text-text-primary',
          )}
        >
          Request
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'response' && (
          <div className="divide-border flex flex-col divide-y">
            {call.error && (
              <Section title="Error" copyText={call.error}>
                <pre className="text-status-offline overflow-x-auto font-mono text-xs whitespace-pre">{call.error}</pre>
              </Section>
            )}
            {responseHeadersStr && (
              <Section title="Headers" copyText={responseHeadersStr}>
                <pre className="text-text-muted overflow-x-auto font-mono text-xs whitespace-pre">
                  {responseHeadersStr}
                </pre>
              </Section>
            )}
            {responseBodyStr && (
              <Section title="Body" copyText={responseBodyStr}>
                <pre className="text-accent overflow-x-auto font-mono text-xs whitespace-pre">{responseBodyStr}</pre>
              </Section>
            )}
            {!call.error && !call.responseBody && !call.responseStatus && (
              <div className="text-text-dim p-3 text-xs">Loading...</div>
            )}
          </div>
        )}
        {tab === 'request' && (
          <div className="divide-border flex flex-col divide-y">
            <Section title="URL" copyText={call.url}>
              <pre className="text-accent overflow-x-auto font-mono text-xs whitespace-pre">{call.url}</pre>
            </Section>
            {requestHeadersStr && (
              <Section title="Headers" copyText={requestHeadersStr}>
                <pre className="text-text-muted overflow-x-auto font-mono text-xs whitespace-pre">
                  {requestHeadersStr}
                </pre>
              </Section>
            )}
            {requestBodyStr && (
              <Section title="Body" copyText={requestBodyStr}>
                <pre className="text-status-warning overflow-x-auto font-mono text-xs whitespace-pre">
                  {requestBodyStr}
                </pre>
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ApiPanel({ className }: ApiPanelProps) {
  const { calls, clear } = useApiMonitor();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState(200);
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedCall = calls.find((c) => c.id === selectedId);
  const displayCall = selectedCall || calls[0];

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const newWidth = Math.max(120, Math.min(400, e.clientX - rect.left));
    setListWidth(newWidth);
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      handleMouseDown(e);
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      const cleanup = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('mouseup', cleanup);
      };
      document.addEventListener('mouseup', cleanup);
    },
    [handleMouseDown, handleMouseMove, handleMouseUp],
  );

  return (
    <div ref={containerRef} className={cn('flex h-full', className)}>
      <div className="border-border flex flex-col border-r" style={{ width: listWidth }}>
        <div className="border-border bg-bg-secondary flex shrink-0 items-center justify-between border-b px-2 py-1">
          <span className="text-text-dim text-xs">{calls.length} calls</span>
          {calls.length > 0 && (
            <button onClick={clear} className="text-text-dim hover:text-text-primary text-xs">
              Clear
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {calls.length === 0 ? (
            <div className="text-text-dim p-3 text-xs">No API calls captured</div>
          ) : (
            calls.map((call) => (
              <div
                key={call.id}
                onClick={() => setSelectedId(call.id)}
                className={cn(
                  'group border-border/50 relative flex w-full cursor-pointer items-center gap-2 border-b px-2 py-1.5 text-left',
                  call.id === displayCall?.id ? 'bg-active-bg' : 'hover:bg-active-bg/50',
                )}
              >
                <MethodBadge method={call.method} />
                <span className="text-text-primary flex-1 truncate text-xs">{call.path}</span>
                <CopyButton text={formatCallForCopy(call)} className="opacity-0 group-hover:opacity-100" />
                <StatusBadge status={call.responseStatus} />
              </div>
            ))
          )}
        </div>
      </div>

      <div
        onMouseDown={startDrag}
        className="bg-border hover:bg-accent w-1 shrink-0 cursor-col-resize transition-colors"
      />

      <div className="flex-1 overflow-hidden">
        {displayCall ? (
          <CallDetail call={displayCall} />
        ) : (
          <div className="text-text-dim flex h-full items-center justify-center text-xs">
            Make an API call to see details
          </div>
        )}
      </div>
    </div>
  );
}

export default ApiPanel;
