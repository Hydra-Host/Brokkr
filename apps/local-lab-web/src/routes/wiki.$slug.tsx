import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

import { getWikiEntry } from '@/lib/wiki';

function WikiTermPage() {
  const { slug } = Route.useParams();
  const entry = getWikiEntry(slug);

  if (!entry) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 font-mono">
        <Link to="/wiki" className="text-text-muted hover:text-accent inline-flex items-center gap-1.5 text-xs">
          <ArrowLeft className="size-3.5" />
          Back to Wiki
        </Link>
        <div className="border-border-dim bg-bg-secondary rounded-sm border px-4 py-8 text-center">
          <h1 className="text-text-primary text-lg font-bold">Term not found</h1>
          <p className="text-text-muted mt-1 text-sm">There's no glossary entry for “{slug}”.</p>
          <Link
            to="/wiki"
            className="border-accent/50 text-accent hover:bg-accent/10 mt-4 inline-block rounded-sm border px-3 py-1.5 text-sm transition-colors"
          >
            Browse all terms
          </Link>
        </div>
      </div>
    );
  }

  const related = (entry.related ?? []).map((s) => getWikiEntry(s)).filter((e) => e !== undefined);

  return (
    <div className="mx-auto max-w-3xl space-y-5 font-mono">
      <Link to="/wiki" className="text-text-muted hover:text-accent inline-flex items-center gap-1.5 text-xs">
        <ArrowLeft className="size-3.5" />
        Back to Wiki
      </Link>

      <header className="space-y-2">
        <div className="text-text-label text-[10px] font-bold tracking-widest uppercase">{entry.category}</div>
        <h1 className="text-text-primary text-2xl font-bold tracking-tight">{entry.title}</h1>
        <p className="border-accent/50 text-text-muted border-l-2 pl-3 text-sm leading-relaxed">{entry.brief}</p>
      </header>

      <article className="space-y-3">{entry.body}</article>

      {related.length > 0 && (
        <footer className="border-border-dim space-y-2 border-t pt-4">
          <div className="text-text-label text-xs font-bold tracking-widest uppercase">Related</div>
          <div className="flex flex-wrap gap-2">
            {related.map((r) => (
              <Link
                key={r.slug}
                to="/wiki/$slug"
                params={{ slug: r.slug }}
                className="border-border-dim bg-bg-secondary text-text-muted hover:border-accent/60 hover:text-accent rounded-sm border px-2.5 py-1 text-xs transition-colors"
              >
                {r.title}
              </Link>
            ))}
          </div>
        </footer>
      )}
    </div>
  );
}

export const Route = createFileRoute('/wiki/$slug')({ component: WikiTermPage });
