import { cn } from '@repo/ui/utils';
import { Check, Copy } from 'lucide-react';
import React, { useRef, useState } from 'react';

// Code blocks stay dark in both themes, matching the docs design language.
export function CodeBlock({ className, children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const language = 'data-language' in props ? String(props['data-language']) : '';

  const copy = async () => {
    const text = preRef.current?.innerText ?? '';
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group relative mb-8">
      <pre
        ref={preRef}
        {...props}
        className={cn(
          'overflow-x-auto rounded-lg border border-[#232a3b] bg-[#111827] p-5 text-sm leading-relaxed text-[#e8edf7]',
          className,
        )}
      >
        {children}
      </pre>
      {language && language !== 'text' && (
        <span className="pointer-events-none absolute top-2.5 right-11 rounded px-1.5 py-0.5 font-mono text-[11px] text-[#6f7c98] uppercase">
          {language}
        </span>
      )}
      <button
        onClick={copy}
        aria-label="Copy code"
        className="absolute top-2 right-2.5 cursor-pointer rounded-md border border-[#232a3b] bg-[#111827] p-1.5 text-[#6f7c98] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#e8edf7]"
      >
        {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

// Horizontal-rule table style in a scrollable rounded frame; the frame owns the outer border.
export function MdxTable(props: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="border-border mb-8 overflow-x-auto rounded-lg border">
      <table {...props} className="w-full border-collapse" />
    </div>
  );
}
