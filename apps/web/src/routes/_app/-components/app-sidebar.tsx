import { AnimatedSidebarLogo } from '@repo/ui/animated-sidebar-logo';
import { Logo } from '@repo/ui/components/logos/logo';
import {
  NavAccordion,
  NavDragHandle,
  NavDropIndicator,
  NavEmptyHint,
  NavPinButton,
  NavRow,
  NavSectionLabel,
  NavTab,
  NavTabList,
  NavTabPanel,
  NavTabs,
  navPrimaryLinkClassName,
  navRowClassName,
} from '@repo/ui/components/nav-menu';
import { Sidebar, SidebarRail } from '@repo/ui/components/sidebar';
import { Link, useLocation } from '@tanstack/react-router';
import { Bookmark, History } from 'lucide-react';
import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@repo/ui/utils';
import {
  type FlatLeaf,
  type NavLeaf,
  type NavSection,
  findLeafByUrl,
  followInternalNavClick,
  getSectionForPathname,
  isLeafActive,
  notifyNavPopupResult,
  openNavPopup,
  safeExternalHref,
  safeInternalPath,
  usePinnedLeaves,
  useRecentLeaves,
} from '~/lib/nav';
import { findPublicPluginRoute, usePluginRegistry } from '~/plugin-host';

const FAVORITES_TITLE = 'Favorites';

export function AppSidebar({ sections, dashboard }: { sections: NavSection[]; dashboard?: NavLeaf }) {
  const { pathname } = useLocation();
  const routeSectionTitle = useMemo(
    () => getSectionForPathname(sections, pathname)?.title ?? null,
    [sections, pathname],
  );
  const footerSections = sections.filter((section) => section.footer);
  const accordionSections = sections.filter((section) => !section.footer);

  const [openTitles, setOpenTitles] = useState<ReadonlySet<string>>(
    () => new Set(routeSectionTitle ? [routeSectionTitle] : []),
  );
  useEffect(() => {
    if (!routeSectionTitle) return;
    setOpenTitles((prev) => (prev.has(routeSectionTitle) ? prev : new Set(prev).add(routeSectionTitle)));
  }, [routeSectionTitle]);

  const toggle = (title: string) =>
    setOpenTitles((prev) => {
      const next = new Set(prev);
      if (!next.delete(title)) next.add(title);
      return next;
    });

  const { pinnedUrls, isPinned, togglePin, reorderPin } = usePinnedLeaves();
  const pinnedLeaves = useMemo<FlatLeaf[]>(
    () => pinnedUrls.map((url) => findLeafByUrl(sections, url)).filter((l): l is FlatLeaf => l !== null),
    [pinnedUrls, sections],
  );
  const recentLeaves = useRecentLeaves(sections, pathname);

  return (
    <Sidebar collapsible="offcanvas">
      <div className="bg-sidebar border-sidebar-border flex h-16 shrink-0 items-center justify-center overflow-hidden border-b px-2">
        <span data-slot="nav-logo-retro" className="contents">
          <AnimatedSidebarLogo />
        </span>
        <Logo data-slot="nav-logo-modern" className="hidden h-12 w-auto" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {dashboard && (
          <Link
            to={dashboard.url}
            data-active={isLeafActive(pathname, dashboard.url) || undefined}
            aria-current={isLeafActive(pathname, dashboard.url) ? 'page' : undefined}
            className={navPrimaryLinkClassName}
          >
            <dashboard.icon className="size-4 shrink-0" />
            {dashboard.title}
          </Link>
        )}

        <NavAccordion
          icon={Bookmark}
          title={FAVORITES_TITLE}
          open={openTitles.has(FAVORITES_TITLE)}
          onToggle={() => toggle(FAVORITES_TITLE)}
        >
          <Favorites
            pinned={pinnedLeaves}
            recent={recentLeaves}
            pathname={pathname}
            onTogglePin={togglePin}
            onReorderPin={reorderPin}
          />
        </NavAccordion>

        {accordionSections.map((section) => (
          <NavAccordion
            key={section.title}
            icon={section.icon}
            title={section.title}
            open={openTitles.has(section.title)}
            onToggle={() => toggle(section.title)}
          >
            <ul className="flex flex-col">
              {section.items.map((leaf) => (
                <LeafRow
                  key={leaf.url}
                  leaf={leaf}
                  pathname={pathname}
                  pinned={isPinned(leaf.url)}
                  onTogglePin={togglePin}
                  className="pl-10"
                />
              ))}
            </ul>
          </NavAccordion>
        ))}
      </div>

      {footerSections.map((section) => (
        <nav key={section.title} aria-label={section.title} className="border-sidebar-border shrink-0 border-t pb-1">
          <NavSectionLabel>{section.title}</NavSectionLabel>
          <ul className="flex flex-col">
            {section.items.map((leaf) => (
              <LeafRow
                key={leaf.url}
                leaf={leaf}
                pathname={pathname}
                pinned={isPinned(leaf.url)}
                onTogglePin={togglePin}
                className="pl-4"
              />
            ))}
          </ul>
        </nav>
      ))}
      <SidebarRail />
    </Sidebar>
  );
}

// Ungrouped leaves (e.g. plugin contributions) come first so they never fall under another group's heading.
type DropTarget = { url: string; position: 'above' | 'below' };

function Favorites({
  pinned,
  recent,
  pathname,
  onTogglePin,
  onReorderPin,
}: {
  pinned: FlatLeaf[];
  recent: FlatLeaf[];
  pathname: string;
  onTogglePin: (url: string) => void;
  onReorderPin: (fromUrl: string, toUrl: string, position: 'above' | 'below') => void;
}) {
  const [tab, setTab] = useState('pinned');

  return (
    <NavTabs value={tab} onValueChange={setTab}>
      <NavTabList>
        <NavTab value="pinned">Pinned</NavTab>
        <NavTab value="recent">Recent</NavTab>
      </NavTabList>
      <NavTabPanel value="pinned">
        <PinnedList leaves={pinned} pathname={pathname} onTogglePin={onTogglePin} onReorderPin={onReorderPin} />
      </NavTabPanel>
      <NavTabPanel value="recent">
        {recent.length === 0 ? (
          <NavEmptyHint>Pages you visit show up here</NavEmptyHint>
        ) : (
          <ul className="flex flex-col">
            {recent.map((leaf) => (
              <LeafRow
                key={`recent-${leaf.url}`}
                leaf={leaf}
                pathname={pathname}
                pinned={false}
                onTogglePin={onTogglePin}
                className="pl-6"
                leading={<History className="text-text-dim size-3.5 shrink-0" />}
              />
            ))}
          </ul>
        )}
      </NavTabPanel>
    </NavTabs>
  );
}

function PinnedList({
  leaves,
  pathname,
  onTogglePin,
  onReorderPin,
}: {
  leaves: FlatLeaf[];
  pathname: string;
  onTogglePin: (url: string) => void;
  onReorderPin: (fromUrl: string, toUrl: string, position: 'above' | 'below') => void;
}) {
  const [draggingUrl, setDraggingUrl] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const handleDragStart = useCallback((e: DragEvent, url: string) => {
    setDraggingUrl(url);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', url);
  }, []);

  const handleDragOver = useCallback(
    (e: DragEvent, url: string) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!draggingUrl || url === draggingUrl) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const position: 'above' | 'below' = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
      setDropTarget((prev) => (prev?.url === url && prev.position === position ? prev : { url, position }));
    },
    [draggingUrl],
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (draggingUrl && dropTarget && draggingUrl !== dropTarget.url)
        onReorderPin(draggingUrl, dropTarget.url, dropTarget.position);
      setDraggingUrl(null);
      setDropTarget(null);
    },
    [draggingUrl, dropTarget, onReorderPin],
  );

  const handleDragEnd = useCallback(() => {
    setDraggingUrl(null);
    setDropTarget(null);
  }, []);

  if (leaves.length === 0) return <NavEmptyHint>Pin a page to add it here</NavEmptyHint>;

  return (
    <ul className="flex flex-col">
      {leaves.map((leaf) => (
        <LeafRow
          key={`pinned-${leaf.url}`}
          leaf={leaf}
          pathname={pathname}
          pinned
          onTogglePin={onTogglePin}
          className="pl-10"
          draggable
          isDragging={draggingUrl === leaf.url}
          dropPosition={
            dropTarget?.url === leaf.url && draggingUrl && draggingUrl !== leaf.url ? dropTarget.position : null
          }
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragEnd={handleDragEnd}
        />
      ))}
    </ul>
  );
}

function LeafRow({
  leaf,
  pathname,
  pinned,
  onTogglePin,
  className,
  leading,
  draggable = false,
  isDragging = false,
  dropPosition = null,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  leaf: NavLeaf;
  pathname: string;
  pinned: boolean;
  onTogglePin: (url: string) => void;
  className: string;
  leading?: ReactNode;
  draggable?: boolean;
  isDragging?: boolean;
  dropPosition?: 'above' | 'below' | null;
  onDragStart?: (e: DragEvent, url: string) => void;
  onDragOver?: (e: DragEvent, url: string) => void;
  onDrop?: (e: DragEvent, url: string) => void;
  onDragEnd?: () => void;
}) {
  const active = isLeafActive(pathname, leaf.url);
  const linkClass = cn(navRowClassName, className);

  return (
    <NavRow
      dragging={isDragging}
      draggable={draggable}
      onDragStart={draggable && onDragStart ? (e) => onDragStart(e, leaf.url) : undefined}
      onDragOver={draggable && onDragOver ? (e) => onDragOver(e, leaf.url) : undefined}
      onDrop={draggable && onDrop ? (e) => onDrop(e, leaf.url) : undefined}
      onDragEnd={draggable && onDragEnd ? onDragEnd : undefined}
    >
      {dropPosition && <NavDropIndicator position={dropPosition} />}
      {draggable && <NavDragHandle />}
      <LeafLink leaf={leaf} active={active} className={linkClass}>
        {leading}
        <span className="truncate">{leaf.title}</span>
      </LeafLink>
      <NavPinButton pinned={pinned} active={active} label={leaf.title} onToggle={() => onTogglePin(leaf.url)} />
    </NavRow>
  );
}

function LeafLink({
  leaf,
  active,
  className,
  children,
}: {
  leaf: NavLeaf;
  active: boolean;
  className: string;
  children: ReactNode;
}) {
  const { publicRoutes } = usePluginRegistry();
  const internalPath = safeInternalPath(leaf.url);
  const publicHref = findPublicPluginRoute(publicRoutes, leaf.url, 'navbar') ? internalPath : undefined;

  if (leaf.popup && internalPath) {
    // Real href so middle-click/cmd-click still work; a plain click
    // opens/focuses the named popup window instead.
    return (
      <a
        href={leaf.url}
        onClick={(e) => {
          e.preventDefault();
          notifyNavPopupResult(openNavPopup(leaf.url), leaf.title);
        }}
        data-slot="nav-leaf"
        className={className}
      >
        {children}
      </a>
    );
  }
  if (leaf.external) {
    return (
      <a
        href={safeExternalHref(leaf.url)}
        target="_blank"
        rel="noopener noreferrer"
        data-slot="nav-leaf"
        className={className}
      >
        {children}
      </a>
    );
  }
  if (publicHref) {
    return (
      <a
        href={publicHref}
        draggable={false}
        data-active={active || undefined}
        aria-current={active ? 'page' : undefined}
        data-slot="nav-leaf"
        className={className}
        onClick={(event) => followInternalNavClick(event, publicHref, (href) => window.location.assign(href))}
      >
        {children}
      </a>
    );
  }
  if (internalPath) {
    return (
      <Link
        to={leaf.url}
        draggable={false}
        data-active={active || undefined}
        aria-current={active ? 'page' : undefined}
        data-slot="nav-leaf"
        className={className}
      >
        {children}
      </Link>
    );
  }
  return (
    <a data-slot="nav-leaf" className={className}>
      {children}
    </a>
  );
}
