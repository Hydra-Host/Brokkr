import { docsSidebar, loadSearchIndex, type DocEntry } from '@/lib/docs-manifest';
import { Button } from '@repo/ui/components/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@repo/ui/components/sheet';
import { ThemeSelector } from '@repo/ui/theme-selector';
import { cn } from '@repo/ui/utils';
import { createFileRoute, Link, Outlet, useLocation } from '@tanstack/react-router';
import { BookOpenText, ChevronRight, Menu } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DocPage } from './_components/-docs-page';

// The sidebar derives from apps/docs/content frontmatter via the docs manifest.
// Adding a page = adding an .mdx file there; nothing to register here.

function DesktopSidebar() {
  const location = useLocation();
  const [filter, setFilter] = useState('');
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [index, setIndex] = useState<ReadonlyMap<string, string> | null>(null);

  const isActive = (slug: string) => location.pathname === `/${slug}`;
  const activeSectionKey = docsSidebar.find((s) => s.items.some((i) => isActive(i.slug)))?.key;
  const query = filter.trim().toLowerCase();

  // Full-text index loads on the first keystroke; titles/descriptions match instantly.
  useEffect(() => {
    if (!query || index) return;
    let cancelled = false;
    void loadSearchIndex().then((loaded) => {
      if (!cancelled) setIndex(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [query, index]);

  const matches = (item: DocEntry) =>
    item.title.toLowerCase().includes(query) ||
    item.description.toLowerCase().includes(query) ||
    (index?.get(item.slug)?.includes(query) ?? false);

  const sections = query
    ? docsSidebar
        .map((section) => ({ ...section, items: section.items.filter(matches) }))
        .filter((section) => section.items.length > 0)
    : docsSidebar;

  // A filter shows every match; otherwise only the active section is open unless toggled.
  const isOpen = (key: string) => (query ? true : (overrides[key] ?? key === activeSectionKey));
  const toggle = (key: string) => setOverrides((prev) => ({ ...prev, [key]: !isOpen(key) }));

  return (
    <nav className="sticky top-28 max-h-[calc(100vh-12rem)] space-y-0.5 overflow-y-auto pr-8 [&>input]:mb-3">
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search docs…"
        className="border-border placeholder:text-muted-foreground focus:border-primary w-full rounded-md border bg-transparent px-3 py-1.5 text-sm outline-none"
      />

      {sections.map((section) => (
        <div key={section.key}>
          <button
            onClick={() => toggle(section.key)}
            className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors"
          >
            {section.label}
            <ChevronRight
              className={cn('size-3.5 shrink-0 transition-transform duration-150', isOpen(section.key) && 'rotate-90')}
              aria-hidden="true"
            />
          </button>

          {isOpen(section.key) && (
            <div className="border-border mt-0.5 ml-4 space-y-0.5 border-l pl-1">
              {section.items.map((item) => (
                <Link
                  key={item.slug}
                  to="/$"
                  params={{ _splat: item.slug }}
                  className={cn(
                    'block rounded-md px-3 py-1.5 text-sm transition-colors',
                    isActive(item.slug)
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                  )}
                >
                  {item.title}
                </Link>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}

export const Route = createFileRoute('/_docs')({
  component: DocsLayout,
});

function DocsLayout() {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isActive = (slug: string) => location.pathname === `/${slug}`;

  return (
    <div className="w-full px-4 py-8 md:px-6 lg:px-10">
      <div className="mb-8 md:mb-12">
        <div className="mb-4 flex flex-row items-center justify-end gap-3 lg:hidden">
          <ThemeSelector />
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetTrigger className="border-border bg-bg-primary hover:bg-accent/10 hover:text-text-primary inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors">
              <Menu className="h-4 w-4" />
              <span>View All Docs</span>
            </SheetTrigger>
            <SheetContent side="right" className="w-full max-w-xs overflow-y-auto">
              <SheetHeader>
                <SheetTitle>Docs Menu</SheetTitle>
                <SheetDescription>Browse documentation topics</SheetDescription>
              </SheetHeader>

              <nav className="mt-6 space-y-6">
                {docsSidebar.map((section) => (
                  <div key={section.key}>
                    <h3 className="text-foreground mb-3 text-sm font-bold tracking-wide uppercase">{section.label}</h3>

                    <div className="space-y-1">
                      {section.items.map((item) => (
                        <Link
                          key={item.slug}
                          to="/$"
                          params={{ _splat: item.slug }}
                          onClick={() => setMobileMenuOpen(false)}
                          className={cn(
                            'block rounded-md px-3 py-2 text-sm transition-colors',
                            isActive(item.slug)
                              ? 'bg-primary/10 text-primary font-medium'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                        >
                          {item.title}
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}

                <div className="border-border border-t pt-6">
                  <Button asChild className="w-full">
                    <a href="/api" className="flex items-center justify-center gap-2">
                      <BookOpenText className="h-4 w-4" />
                      View API Reference
                    </a>
                  </Button>
                </div>
              </nav>
            </SheetContent>
          </Sheet>
        </div>

        <div className="hidden items-center justify-between lg:flex">
          <Button asChild>
            <a href="/api" className="flex items-center gap-2">
              <BookOpenText className="h-4 w-4" />
              View API Reference
            </a>
          </Button>
          <ThemeSelector />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 pt-4 md:pt-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-12 xl:grid-cols-[280px_minmax(0,1fr)_240px] 2xl:grid-cols-[340px_minmax(0,1fr)_320px] 2xl:gap-16">
        <div className="border-border hidden border-r lg:block">
          <DesktopSidebar />
        </div>

        <div className="min-w-0">
          <Outlet />
        </div>

        <div className="hidden xl:block">
          <DocPage.TableOfContents />
        </div>
      </div>
    </div>
  );
}
