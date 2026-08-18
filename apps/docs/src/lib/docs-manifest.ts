// Docs manifest — derives the docs experience (sidebar, ordering, prev/next, cards) from apps/docs/content frontmatter.
// Authoring contract (frontmatter fields, adding pages/sections): apps/docs/STYLE.md.
import { BRAND_NAME } from '@/lib/branding';
import type { ComponentType } from 'react';

export interface DocFrontmatter {
  title: string;
  description?: string;
  section: string;
  order?: number;
  slug?: string;
}

export interface DocEntry {
  slug: string;
  title: string;
  description: string;
  section: string;
  order: number;
  /** Content-relative source path (e.g. "network/ipam.mdx") — slugs can diverge from file paths. */
  file: string;
  load: () => Promise<{ default: ComponentType<Record<string, unknown>> }>;
}

export interface DocSection {
  key: string;
  label: string;
  items: DocEntry[];
}

/** Sidebar sections, in display order. `hidden` keeps pages routable but out of the nav (e.g. legal). */
const SECTIONS: { key: string; label: string; hidden?: boolean }[] = [
  { key: 'about', label: 'About' },
  { key: 'get-started', label: 'Get started' },
  { key: 'self-host', label: 'Self-host' },
  { key: 'zones', label: 'Zones & provisioning' },
  { key: 'os-builds', label: 'OS builds & layers' },
  { key: 'network', label: 'Network' },
  { key: 'infrastructure', label: 'Physical infrastructure' },
  { key: 'organizations', label: 'Organizations & access' },
  { key: 'deployments', label: 'Deployments' },
  { key: 'security', label: 'Security' },
  { key: 'extend', label: 'Extend' },
  { key: 'api', label: 'API' },
  { key: 'help', label: 'Help' },
  { key: 'legal', label: 'Legal', hidden: true },
];

const CONTENT_ROOT = '../../content/';

// Lazy module map: each page becomes its own chunk, loaded on navigation.
const modules = import.meta.glob('../../content/**/*.mdx') as Record<
  string,
  () => Promise<{ default: ComponentType<Record<string, unknown>> }>
>;

// Eager frontmatter-only imports: cheap metadata for nav/cards. `sideEffects:
// false` in @repo/docs lets the bundler drop the page bodies from this graph.
const metas = import.meta.glob('../../content/**/*.mdx', {
  eager: true,
  import: 'frontmatter',
}) as Record<string, DocFrontmatter>;

function relPath(path: string): string {
  return path.slice(path.indexOf(CONTENT_ROOT) + CONTENT_ROOT.length);
}

function defaultSlug(path: string): string {
  return relPath(path).replace(/\.mdx$/, '');
}

const sectionRank = new Map(SECTIONS.map((s, i) => [s.key, i]));

// Frontmatter is static YAML, so brand tokens arrive as literal "{BRAND_NAME}"
// text (unlike the MDX body, where they're real JSX expressions). Substitute here.
function brand(s: string): string {
  return s.split('{BRAND_NAME}').join(BRAND_NAME);
}

const allDocs: DocEntry[] = Object.entries(metas)
  .map(([path, fm]) => ({
    slug: fm.slug ?? defaultSlug(path),
    title: brand(fm.title),
    description: brand(fm.description ?? ''),
    section: fm.section,
    order: fm.order ?? 999,
    file: relPath(path),
    load: modules[path],
  }))
  .sort(
    (a, b) =>
      (sectionRank.get(a.section) ?? 99) - (sectionRank.get(b.section) ?? 99) ||
      a.order - b.order ||
      a.title.localeCompare(b.title),
  );

export const docsBySlug: ReadonlyMap<string, DocEntry> = new Map(allDocs.map((d) => [d.slug, d]));

/** Visible sidebar sections with their pages (empty and hidden sections omitted). */
export const docsSidebar: DocSection[] = SECTIONS.filter((s) => !s.hidden)
  .map((s) => ({ key: s.key, label: s.label, items: allDocs.filter((d) => d.section === s.key) }))
  .filter((s) => s.items.length > 0);

export function sectionLabel(key: string): string {
  return SECTIONS.find((s) => s.key === key)?.label ?? key;
}

let searchIndexPromise: Promise<ReadonlyMap<string, string>> | null = null;

/** Full-text search index (slug -> lowercased page source), lazy-loaded on first use. */
export function loadSearchIndex(): Promise<ReadonlyMap<string, string>> {
  searchIndexPromise ??= import('virtual:docs-search-index').then(
    (mod) => new Map(allDocs.map((d) => [d.slug, mod.default[d.file] ?? ''])),
  );
  return searchIndexPromise;
}

// "Edit on GitHub" link base — override for forks or self-hosted mirrors.
const DOCS_EDIT_BASE =
  import.meta.env.VITE_DOCS_EDIT_BASE?.trim() || 'https://github.com/Hydra-Host/Brokkr/blob/master/apps/docs/content/';

export function docEditUrl(doc: DocEntry): string {
  return `${DOCS_EDIT_BASE}${doc.file}`;
}

/** Linear reading order across visible sections — drives Previous/Next. */
const flatNav: DocEntry[] = docsSidebar.flatMap((s) => s.items);

export function prevNext(slug: string): { prev?: DocEntry; next?: DocEntry } {
  const i = flatNav.findIndex((d) => d.slug === slug);
  if (i === -1) return {};
  return { prev: flatNav[i - 1], next: flatNav[i + 1] };
}
