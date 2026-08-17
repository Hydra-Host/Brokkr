import { useState } from 'react';

import { CopyButton } from './copy-button';
import { isJsonLike } from './json';

export function Cell({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  if (value === null || value === undefined) return <span className="text-text-label italic">null</span>;

  const asObject = typeof value === 'object';
  const jsonStr = asObject
    ? JSON.stringify(value, null, 2)
    : isJsonLike(value)
      ? JSON.stringify(JSON.parse(value), null, 2)
      : null;

  if (jsonStr !== null) {
    const oneLine = jsonStr.replace(/\s+/g, ' ');
    return (
      <span className="inline-flex max-w-full items-start gap-1">
        <button onClick={() => setOpen((o) => !o)} className="text-accent/70 hover:text-accent mt-0.5 text-[10px]">
          {open ? '▾' : '▸'}
        </button>
        {open ? (
          <pre className="text-status-online/90 max-w-[60ch] whitespace-pre-wrap">{jsonStr}</pre>
        ) : (
          <span className="text-status-online/80 inline-block max-w-[40ch] truncate align-bottom">{oneLine}</span>
        )}
        <CopyButton value={jsonStr} />
      </span>
    );
  }

  const str = String(value);
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <span className="inline-block max-w-[60ch] truncate align-bottom">{str}</span>
      {str.length > 24 && <CopyButton value={str} />}
    </span>
  );
}
