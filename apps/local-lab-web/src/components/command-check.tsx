import { Check, Clipboard } from 'lucide-react';
import { useState } from 'react';

import { copyText } from '@/lib/clipboard';

export interface CommandCheckProps {
  command: string;
  hint?: string;
  label?: string;
}

export function CommandCheck({ command, hint, label }: CommandCheckProps) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="my-2 space-y-1.5">
      {label ? <p className="text-text-dim text-xs">{label}</p> : null}
      <div className="relative">
        <code className="border-border-dim bg-bg-secondary text-accent block overflow-x-auto rounded-sm border py-1.5 pr-9 pl-2 font-mono text-[0.8rem] leading-relaxed whitespace-pre">
          {command}
        </code>
        <button
          type="button"
          title={copied ? 'Copied!' : 'Copy'}
          aria-label={copied ? 'Command copied to clipboard' : `Copy command: ${command}`}
          onClick={() => {
            void copyText(command).then((ok) => {
              if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            });
          }}
          className="text-text-muted hover:bg-hover-bg hover:text-accent absolute top-1.5 right-1 flex size-6 items-center justify-center rounded-sm transition-colors"
        >
          {copied ? <Check className="text-status-online size-3.5" /> : <Clipboard className="size-3.5" />}
        </button>
      </div>
      {hint ? (
        <p className="text-text-muted text-xs leading-relaxed">
          <span aria-hidden className="text-status-online mr-1">
            ✓
          </span>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
