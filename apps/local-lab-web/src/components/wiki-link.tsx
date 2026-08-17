import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { getWikiEntry } from '@/lib/wiki/store';

/** Resolves from the leaf at render time — importing `@/lib/wiki` here would cycle, and the leaf is empty until that index evaluates. */
export function WikiLink({ slug, children }: { slug: string; children?: ReactNode }) {
  const entry = getWikiEntry(slug);

  if (!entry) {
    return <>{children}</>;
  }

  return (
    <Link
      to="/wiki/$slug"
      params={{ slug }}
      title={entry.brief}
      className="text-accent hover:bg-hover-bg rounded-sm underline decoration-dotted underline-offset-2 transition-colors hover:decoration-solid"
    >
      {children ?? entry.title}
    </Link>
  );
}
