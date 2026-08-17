import { AnimatedSidebarLogo } from '@repo/ui/animated-sidebar-logo';
import { Sidebar, SidebarRail, useSidebar } from '@repo/ui/components/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/tooltip';
import { Link, useLocation } from '@tanstack/react-router';
import { GripVertical, Pin } from 'lucide-react';
import {
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type FlatLeaf,
  type NavLeaf,
  type NavSection,
  findLeafByUrl,
  getSectionForPathname,
  isLeafActive,
  notifyNavPopupResult,
  openNavPopup,
  safeExternalHref,
  safeInternalPath,
  usePinnedLeaves,
} from '@/lib/nav';
import { cn } from '@repo/ui/utils';

export function AppSidebar({
  sections,
  dashboard,
  orgSwitcher,
  userMenu,
}: {
  sections: NavSection[];
  dashboard?: NavLeaf;
  orgSwitcher?: ReactNode;
  userMenu?: ReactNode;
}) {
  const location = useLocation();
  const { state } = useSidebar();
  const isCollapsed = state === 'collapsed';

  const routeSectionTitle = useMemo(
    () => getSectionForPathname(sections, location.pathname)?.title ?? null,
    [sections, location.pathname],
  );

  const defaultTitle = sections[0]?.title ?? '';
  const [selectedTitle, setSelectedTitle] = useState<string>(() => routeSectionTitle ?? defaultTitle);

  const prevRouteSection = useRef(routeSectionTitle);
  useEffect(() => {
    if (routeSectionTitle !== prevRouteSection.current) {
      prevRouteSection.current = routeSectionTitle;
      setSelectedTitle(routeSectionTitle ?? defaultTitle);
    }
  }, [routeSectionTitle, defaultTitle]);

  const selectedSection = sections.find((s) => s.title === selectedTitle) ?? sections[0];

  const { pinnedUrls, isPinned, togglePin, reorderPin } = usePinnedLeaves();
  const pinnedLeaves = useMemo<FlatLeaf[]>(
    () => pinnedUrls.map((url) => findLeafByUrl(sections, url)).filter((l): l is FlatLeaf => l !== null),
    [pinnedUrls, sections],
  );

  return (
    <Sidebar collapsible="icon">
      <div className="flex h-full min-h-0 overflow-hidden">
        <IconRail
          sections={sections}
          dashboard={dashboard}
          selectedTitle={selectedTitle}
          routeSectionTitle={routeSectionTitle}
          onSelectSection={setSelectedTitle}
          userMenu={userMenu}
        />
        {selectedSection && (
          <SectionPanel
            section={selectedSection}
            header={orgSwitcher}
            pathname={location.pathname}
            pinnedLeaves={pinnedLeaves}
            isPinned={isPinned}
            onTogglePin={togglePin}
            onReorderPin={reorderPin}
            collapsed={isCollapsed}
          />
        )}
      </div>
      <SidebarRail />
    </Sidebar>
  );
}

function IconRail({
  sections,
  dashboard,
  selectedTitle,
  routeSectionTitle,
  onSelectSection,
  userMenu,
}: {
  sections: NavSection[];
  dashboard?: NavLeaf;
  selectedTitle: string;
  routeSectionTitle: string | null;
  onSelectSection: (title: string) => void;
  userMenu?: ReactNode;
}) {
  const { state, setOpen } = useSidebar();
  const location = useLocation();
  const isCollapsed = state === 'collapsed';

  const handleSectionClick = (title: string) => {
    onSelectSection(title);
    if (state === 'collapsed') setOpen(true);
  };

  return (
    <nav
      aria-label="Primary"
      className="bg-sidebar border-sidebar-border flex w-12 shrink-0 flex-col items-center border-r"
    >
      <div className="flex h-16 w-full items-center justify-center overflow-hidden">
        <AnimatedSidebarLogo collapsed />
      </div>

      {dashboard && (
        <>
          <RailLink to={dashboard.url} label={dashboard.title} active={isLeafActive(location.pathname, dashboard.url)}>
            <dashboard.icon className="size-4" />
          </RailLink>
          <div className="bg-sidebar-border my-1 h-px w-6" />
        </>
      )}

      <div className="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto">
        {sections.map((section) => {
          const Icon = section.icon;
          // A single-leaf popup section's rail icon opens the popup directly; the open must stay
          // synchronous inside the click handler — window.open needs the gesture.
          const soleLeaf = section.items.length === 1 ? section.items[0] : undefined;
          const popupLeaf = soleLeaf?.popup && safeInternalPath(soleLeaf.url) ? soleLeaf : undefined;
          return (
            <RailIconButton
              key={section.title}
              label={popupLeaf ? popupLeaf.title : section.title}
              active={section.title === routeSectionTitle}
              selected={!popupLeaf && section.title === selectedTitle && !isCollapsed}
              onClick={() => {
                if (popupLeaf) {
                  notifyNavPopupResult(openNavPopup(popupLeaf.url), popupLeaf.title);
                  return;
                }
                handleSectionClick(section.title);
              }}
            >
              <Icon className="size-4" />
            </RailIconButton>
          );
        })}
      </div>

      {userMenu && (
        <>
          <div className="bg-sidebar-border my-1 h-px w-6" />
          <div className="my-2 flex items-center justify-center">{userMenu}</div>
        </>
      )}
    </nav>
  );
}

function RailIconButton({
  label,
  active,
  selected,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild delay={0}>
        <button
          type="button"
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          onClick={onClick}
          data-selected={selected || undefined}
          className="text-sidebar-foreground hover:bg-accent/10 data-selected:bg-sidebar-section-bg relative my-0.5 flex size-8 items-center justify-center rounded-sm transition-colors"
        >
          {children}
          {active && (
            <span className="bg-accent absolute top-1/2 -right-px h-4 w-[2px] -translate-y-1/2 shadow-[0_0_4px_var(--color-accent-glow)]" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function RailLink({
  to,
  label,
  active,
  children,
}: {
  to: string;
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild delay={0}>
        <Link
          to={to}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          className="text-sidebar-foreground hover:bg-accent/10 relative my-0.5 flex size-8 items-center justify-center rounded-sm transition-colors"
        >
          {children}
          {active && (
            <span className="bg-accent absolute top-1/2 -right-px h-4 w-[2px] -translate-y-1/2 shadow-[0_0_4px_var(--color-accent-glow)]" />
          )}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

type DropTarget = { url: string; position: 'above' | 'below' };

function SectionPanel({
  section,
  header,
  pathname,
  pinnedLeaves,
  isPinned,
  onTogglePin,
  onReorderPin,
  collapsed,
}: {
  section: NavSection;
  header?: ReactNode;
  pathname: string;
  pinnedLeaves: FlatLeaf[];
  isPinned: (url: string) => boolean;
  onTogglePin: (url: string) => void;
  onReorderPin: (fromUrl: string, toUrl: string, position: 'above' | 'below') => void;
  collapsed: boolean;
}) {
  const SectionIcon = section.icon;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRegionRef = useRef<HTMLDivElement>(null);
  const prevPinnedHeightRef = useRef<number | null>(null);

  const [draggingUrl, setDraggingUrl] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  useLayoutEffect(() => {
    const pinnedHeight = pinnedRegionRef.current?.offsetHeight ?? 0;
    const prev = prevPinnedHeightRef.current;
    prevPinnedHeightRef.current = pinnedHeight;
    if (prev === null) return;
    const delta = pinnedHeight - prev;
    if (scrollRef.current && delta !== 0) scrollRef.current.scrollTop += delta;
  }, [pinnedLeaves.length]);

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

  return (
    <div className={cn('min-w-0 flex-1 flex-col overflow-hidden', collapsed ? 'hidden' : 'flex')}>
      {header && <div className="bg-sidebar border-sidebar-border flex h-16 items-center border-b px-2">{header}</div>}

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-2 pb-2">
        <div ref={pinnedRegionRef}>
          <SectionHeader
            icon={Pin}
            iconClassName={pinnedLeaves.length > 0 ? 'fill-current' : undefined}
            label="PINNED"
            tone={pinnedLeaves.length > 0 ? 'accent' : 'default'}
          />
          {pinnedLeaves.length > 0 ? (
            <ul className="flex flex-col gap-px px-2 pt-1 pb-1">
              {pinnedLeaves.map((leaf) => {
                const dropPosition =
                  dropTarget?.url === leaf.url && draggingUrl && draggingUrl !== leaf.url ? dropTarget.position : null;
                return (
                  <LeafRow
                    key={`pinned-${leaf.url}`}
                    leaf={leaf}
                    pathname={pathname}
                    pinned
                    onTogglePin={onTogglePin}
                    draggable
                    isDragging={draggingUrl === leaf.url}
                    dropPosition={dropPosition}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                  />
                );
              })}
            </ul>
          ) : (
            <div className="text-muted-foreground/60 flex h-7 items-center px-3 pt-1 text-xs italic">
              Click the pin icon to bookmark a page
            </div>
          )}
        </div>

        <SectionHeader icon={SectionIcon} label={section.title} tone="default" className="mt-2" />
        <ul className="flex flex-col gap-px px-2 pt-1">
          {section.items.map((leaf) => (
            <LeafRow
              key={leaf.url}
              leaf={leaf}
              pathname={pathname}
              pinned={isPinned(leaf.url)}
              onTogglePin={onTogglePin}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  iconClassName,
  label,
  tone,
  className,
}: {
  icon: NavSection['icon'];
  iconClassName?: string;
  label: string;
  tone: 'default' | 'accent';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'bg-sidebar-section-bg flex h-7 w-full items-center gap-2 px-2 text-sm font-bold uppercase',
        tone === 'accent' ? 'text-accent-glow' : 'text-sidebar-foreground',
        className,
      )}
    >
      <Icon className={cn('size-4 shrink-0', iconClassName)} />
      <span className="truncate">/{label.toUpperCase()}/</span>
    </div>
  );
}

function LeafRow({
  leaf,
  pathname,
  pinned,
  onTogglePin,
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
  draggable?: boolean;
  isDragging?: boolean;
  dropPosition?: 'above' | 'below' | null;
  onDragStart?: (e: DragEvent, url: string) => void;
  onDragOver?: (e: DragEvent, url: string) => void;
  onDrop?: (e: DragEvent, url: string) => void;
  onDragEnd?: () => void;
}) {
  const Icon = leaf.icon;
  const active = isLeafActive(pathname, leaf.url);

  const linkClass = cn(
    'text-sidebar-foreground hover:bg-accent/10 data-active:text-accent-glow data-active:font-medium relative flex h-7 w-full items-center gap-2 rounded-sm pr-8 text-sm transition-colors',
    draggable ? 'pl-5' : 'pl-2',
  );

  return (
    <li
      className={cn('group/leaf relative', isDragging && 'opacity-40')}
      draggable={draggable}
      onDragStart={draggable && onDragStart ? (e) => onDragStart(e, leaf.url) : undefined}
      onDragOver={draggable && onDragOver ? (e) => onDragOver(e, leaf.url) : undefined}
      onDrop={draggable && onDrop ? (e) => onDrop(e, leaf.url) : undefined}
      onDragEnd={draggable && onDragEnd ? onDragEnd : undefined}
    >
      {dropPosition === 'above' && (
        <span
          aria-hidden="true"
          className="bg-accent pointer-events-none absolute -top-px right-2 left-2 h-px shadow-[0_0_4px_var(--color-accent-glow)]"
        />
      )}
      {dropPosition === 'below' && (
        <span
          aria-hidden="true"
          className="bg-accent pointer-events-none absolute right-2 -bottom-px left-2 h-px shadow-[0_0_4px_var(--color-accent-glow)]"
        />
      )}
      {draggable && (
        <span
          aria-hidden="true"
          className="text-muted-foreground/40 group-hover/leaf:text-muted-foreground pointer-events-none absolute top-1/2 left-0 flex size-4 -translate-y-1/2 items-center justify-center transition-colors"
        >
          <GripVertical className="size-3" />
        </span>
      )}
      {leaf.popup && safeInternalPath(leaf.url) ? (
        // Real href so middle-click/cmd-click still work; a plain click
        // opens/focuses the named popup window instead.
        <a
          href={leaf.url}
          onClick={(e) => {
            e.preventDefault();
            notifyNavPopupResult(openNavPopup(leaf.url), leaf.title);
          }}
          className={linkClass}
        >
          <Icon className="size-4 shrink-0 opacity-70" />
          <span className="truncate">{leaf.title}</span>
        </a>
      ) : leaf.external ? (
        <a href={safeExternalHref(leaf.url)} target="_blank" rel="noopener noreferrer" className={linkClass}>
          <Icon className="size-4 shrink-0 opacity-70" />
          <span className="truncate">{leaf.title}</span>
        </a>
      ) : safeInternalPath(leaf.url) ? (
        <Link to={leaf.url} draggable={false} data-active={active || undefined} className={linkClass}>
          <Icon className="size-4 shrink-0 opacity-70" />
          <span className="truncate">{leaf.title}</span>
        </Link>
      ) : (
        <a className={linkClass}>
          <Icon className="size-4 shrink-0 opacity-70" />
          <span className="truncate">{leaf.title}</span>
        </a>
      )}
      <button
        type="button"
        aria-label={pinned ? `Unpin ${leaf.title}` : `Pin ${leaf.title}`}
        title={pinned ? `Unpin ${leaf.title}` : `Pin ${leaf.title}`}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onTogglePin(leaf.url);
        }}
        className={cn(
          'hover:bg-accent/20 absolute top-1/2 right-1 z-10 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm transition-opacity',
          pinned
            ? 'text-accent-glow opacity-100'
            : 'text-muted-foreground opacity-0 group-hover/leaf:opacity-100 focus-visible:opacity-100',
        )}
      >
        <Pin className={cn('size-3.5', pinned && 'rotate-45 fill-current')} />
      </button>
    </li>
  );
}
