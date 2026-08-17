import { Link } from '@tanstack/react-router';
import { Check, Clipboard } from 'lucide-react';
import { isValidElement, type ReactNode, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { copyText } from '@/lib/clipboard';
import { suspendActiveTourForNav } from '@/lib/tour';
import { getWikiEntry } from '@/lib/wiki';

const TERMS: { regex: RegExp; slug: string }[] = [
  { regex: /\bhubs?\b/i, slug: 'hub' },
  { regex: /\bspokes?\b/i, slug: 'spoke' },
  { regex: /\bbridges?\b/i, slug: 'spoke' },
  { regex: /\bbmcs?\b/i, slug: 'bmc' },
  { regex: /\bpostgres(?:ql)?\b/i, slug: 'postgres' },
  { regex: /\bredis\b/i, slug: 'redis' },
];

const briefFor = (slug: string): string => getWikiEntry(slug)?.brief ?? '';

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  children?: MdNode[];
}

const SKIP = new Set(['link', 'linkReference', 'code', 'inlineCode', 'heading']);

function remarkWikiLinks() {
  const seen = new Set<string>();

  const linkify = (value: string): MdNode[] => {
    const out: MdNode[] = [];
    let rest = value;
    for (;;) {
      let best: { index: number; length: number; slug: string; text: string } | null = null;
      for (const { regex, slug } of TERMS) {
        if (seen.has(slug)) continue;
        const m = regex.exec(rest);
        if (m && (best === null || m.index < best.index)) {
          best = { index: m.index, length: m[0].length, slug, text: m[0] };
        }
      }
      if (!best) {
        if (rest) out.push({ type: 'text', value: rest });
        break;
      }
      if (best.index > 0) out.push({ type: 'text', value: rest.slice(0, best.index) });
      out.push({
        type: 'link',
        url: `/wiki/${best.slug}`,
        title: briefFor(best.slug),
        children: [{ type: 'text', value: best.text }],
      });
      seen.add(best.slug);
      rest = rest.slice(best.index + best.length);
    }
    return out;
  };

  const walk = (parent: MdNode) => {
    if (!parent.children) return;
    const next: MdNode[] = [];
    for (const child of parent.children) {
      if (child.type === 'text') {
        next.push(...linkify(child.value ?? ''));
      } else if (SKIP.has(child.type)) {
        next.push(child);
      } else {
        walk(child);
        next.push(child);
      }
    }
    parent.children = next;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => walk(tree as MdNode);
}

function WikiTermLink({ slug, brief, children }: { slug: string; brief: string; children: ReactNode }) {
  return (
    <span className="group/term relative inline-block">
      <Link
        to="/wiki/$slug"
        params={{ slug }}
        onClick={() => suspendActiveTourForNav()}
        className="text-accent decoration-accent/50 hover:decoration-accent underline decoration-dotted underline-offset-2"
      >
        {children}
      </Link>
      {brief ? (
        <span
          role="tooltip"
          className="border-border-dim bg-bg-secondary text-text-muted pointer-events-none absolute top-full left-0 z-50 mt-1 hidden w-64 rounded-sm border p-2 text-xs leading-snug font-normal shadow-lg group-hover/term:block"
        >
          {brief}
        </span>
      ) : null}
    </span>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children);
  return '';
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={copied ? 'Copied!' : 'Copy'}
      aria-label="Copy code to clipboard"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (ok) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        });
      }}
      className="border-border-dim bg-bg-primary/70 text-text-muted hover:bg-hover-bg hover:text-accent absolute top-1.5 right-1.5 flex size-7 items-center justify-center rounded-sm border opacity-0 transition-opacity group-hover/code:opacity-100 focus:opacity-100"
    >
      {copied ? <Check className="text-status-online size-3.5" /> : <Clipboard className="size-3.5" />}
    </button>
  );
}

const components: Components = {
  h1: ({ node: _n, ...p }) => <h1 className="text-text-primary mt-2 mb-3 text-2xl font-bold tracking-tight" {...p} />,
  h2: ({ node: _n, ...p }) => (
    <h2
      className="border-border-dim text-text-primary mt-8 mb-2 border-b pb-1 text-xl font-bold tracking-tight"
      {...p}
    />
  ),
  h3: ({ node: _n, ...p }) => <h3 className="text-text-primary mt-6 mb-2 text-base font-semibold" {...p} />,
  p: ({ node: _n, ...p }) => <p className="text-text-muted my-3 text-sm leading-relaxed" {...p} />,
  a: ({ node: _n, href, title, children }) => {
    if (href?.startsWith('/wiki/')) {
      return (
        <WikiTermLink slug={href.slice('/wiki/'.length)} brief={title ?? ''}>
          {children}
        </WikiTermLink>
      );
    }
    return (
      <a
        href={href}
        target={href?.startsWith('http') ? '_blank' : undefined}
        rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
        title={title}
        className="text-accent decoration-accent/40 hover:decoration-accent underline underline-offset-2"
      >
        {children}
      </a>
    );
  },
  ul: ({ node: _n, ...p }) => <ul className="text-text-muted my-3 list-disc space-y-1.5 pl-5 text-sm" {...p} />,
  ol: ({ node: _n, ...p }) => <ol className="text-text-muted my-3 list-decimal space-y-1.5 pl-5 text-sm" {...p} />,
  li: ({ node: _n, ...p }) => <li className="marker:text-text-dim leading-relaxed" {...p} />,
  blockquote: ({ node: _n, ...p }) => (
    <blockquote
      className="border-accent/50 bg-bg-secondary/50 text-text-muted my-3 border-l-2 py-1 pl-3 text-sm"
      {...p}
    />
  ),
  hr: () => <hr className="border-border-dim my-6" />,
  pre: ({ node: _n, children }) => {
    const text = extractText(children).replace(/\n+$/, '');
    return (
      <div className="group/code relative my-3">
        <pre className="border-border-dim bg-bg-secondary text-text-primary overflow-x-auto rounded-sm border p-3 pr-10 text-xs leading-relaxed">
          {children}
        </pre>
        <CopyButton text={text} />
      </div>
    );
  },
  code: ({ node: _n, className, children, ...p }) =>
    /language-/.test(className ?? '') ? (
      <code className={className} {...p}>
        {children}
      </code>
    ) : (
      <code className="bg-bg-primary/60 text-accent rounded px-1 py-0.5 font-mono text-[0.85em]" {...p}>
        {children}
      </code>
    ),
  table: ({ node: _n, ...p }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...p} />
    </div>
  ),
  th: ({ node: _n, ...p }) => (
    <th
      className="border-border-dim bg-bg-secondary text-text-primary border px-3 py-1.5 text-left font-semibold"
      {...p}
    />
  ),
  td: ({ node: _n, ...p }) => <td className="border-border-dim text-text-muted border px-3 py-1.5 align-top" {...p} />,
  img: ({ node: _n, ...p }) => <img className="my-3 max-w-full rounded-sm" {...p} />,
};

export function MarkdownDoc({ markdown }: { markdown: string }) {
  return (
    <article>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkWikiLinks]} components={components}>
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
