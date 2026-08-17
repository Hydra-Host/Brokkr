import type { ReactNode } from 'react';

export function P({ children }: { children: ReactNode }) {
  return <p className="text-text-muted text-sm leading-relaxed">{children}</p>;
}

export function H({ children }: { children: ReactNode }) {
  return <h2 className="text-text-label pt-2 text-xs font-bold tracking-widest uppercase">{children}</h2>;
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="text-text-muted marker:text-text-dim ml-4 list-disc space-y-1 text-sm leading-relaxed">
      {children}
    </ul>
  );
}

export function OL({ children }: { children: ReactNode }) {
  return (
    <ol className="text-text-muted marker:text-text-dim ml-4 list-decimal space-y-1 text-sm leading-relaxed">
      {children}
    </ol>
  );
}

export function OLA({ children }: { children: ReactNode }) {
  return (
    <ol
      style={{ listStyleType: 'lower-alpha' }}
      className="text-text-muted marker:text-text-dim ml-4 space-y-4 text-sm leading-relaxed"
    >
      {children}
    </ol>
  );
}

export function Expand({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="border-border-dim bg-bg-secondary/40 mt-1 rounded-sm border text-xs">
      <summary className="text-text-muted marker:text-text-dim hover:text-accent cursor-pointer px-2 py-1 select-none">
        {summary}
      </summary>
      <div className="border-border-dim text-text-muted space-y-1.5 border-t px-2 py-2 leading-relaxed">{children}</div>
    </details>
  );
}

export function Small({ children }: { children: ReactNode }) {
  return <p className="text-text-dim text-xs leading-relaxed">{children}</p>;
}

const CTA_CLASS =
  'text-accent font-medium underline decoration-dotted underline-offset-2 transition hover:decoration-solid';

/** Dispatches a window event (handled in TourBootstrap) rather than importing the tour module — avoids a wiki ↔ tour circular import. */
export function DeployCta({ children }: { children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('lab:start-deploy-tour'))}
      className={CTA_CLASS}
    >
      {children}
    </button>
  );
}

export function OpsCta({ children }: { children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('lab:start-ops-tour'))}
      className={CTA_CLASS}
    >
      {children}
    </button>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return <li>{children}</li>;
}

export function Term({ children }: { children: ReactNode }) {
  return <span className="text-text-primary">{children}</span>;
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="border-border-dim bg-bg-secondary text-accent rounded-sm border px-1 py-0.5 text-[0.85em]">
      {children}
    </code>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="border-accent/40 bg-accent/5 text-text-muted rounded-sm border px-3 py-2 text-sm leading-relaxed">
      {children}
    </div>
  );
}
