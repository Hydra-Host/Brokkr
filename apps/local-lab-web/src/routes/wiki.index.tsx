import { createFileRoute, Link } from '@tanstack/react-router';
import { BookOpen, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { SectionHeading } from '@/components/console';
import type { WikiEntry } from '@/lib/wiki';
import { WIKI_LIST } from '@/lib/wiki';

const CATEGORY_ORDER: WikiEntry['category'][] = ['Concepts', 'Navigation', 'Services', 'Data', 'How-to'];

function WikiIndexPage() {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return WIKI_LIST;
    return WIKI_LIST.filter(
      (e) => e.title.toLowerCase().includes(q) || e.brief.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q),
    );
  }, [query]);

  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        entries: filtered.filter((e) => e.category === category),
      })).filter((g) => g.entries.length > 0),
    [filtered],
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6 font-mono">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <BookOpen className="text-accent size-5" />
          <h1 className="text-text-primary text-xl font-bold tracking-tight">Wiki</h1>
        </div>
        <p className="text-text-muted text-sm">
          A glossary for the brokkr·sim cockpit. Click any term to read its definition.
        </p>
      </div>

      <label className="relative block">
        <Search className="text-text-dim pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search terms…"
          autoFocus
          className="border-border-dim bg-bg-secondary text-text-primary placeholder:text-text-dim focus:border-accent w-full rounded-sm border py-2 pr-3 pl-9 text-sm focus:outline-none"
        />
      </label>

      {groups.length === 0 ? (
        <div className="border-border-dim bg-bg-secondary text-text-muted rounded-sm border px-4 py-8 text-center text-sm">
          No terms match “{query}”.
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.category} className="space-y-2">
              <SectionHeading>{group.category}</SectionHeading>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.entries.map((entry) => (
                  <Link
                    key={entry.slug}
                    to="/wiki/$slug"
                    params={{ slug: entry.slug }}
                    className="group border-border-dim bg-bg-secondary hover:border-accent/60 block rounded-sm border px-3 py-2.5 transition-colors"
                  >
                    <div className="text-text-primary group-hover:text-accent text-sm font-medium">{entry.title}</div>
                    <div className="text-text-muted mt-0.5 text-xs leading-relaxed">{entry.brief}</div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/wiki/')({ component: WikiIndexPage });
