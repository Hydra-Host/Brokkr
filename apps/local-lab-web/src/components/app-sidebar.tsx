import { Link, useLocation } from '@tanstack/react-router';
import {
  AppWindow,
  ArrowRight,
  Boxes,
  ClipboardList,
  Cog,
  Database,
  ExternalLink,
  FileCode,
  FlaskConical,
  Gauge,
  HardDrive,
  Hash,
  Layers,
  Library,
  ListChecks,
  Network,
  Package,
  Rocket,
  ScrollText,
  Server,
  ServerCog,
  SlidersHorizontal,
  Webhook,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Fragment } from 'react';

import { SidebarWordmark } from '@/components/logos/sidebar-wordmark';
import { cn } from '@/components/ui/utils';
import { tsr } from '@/lib/api';
import { usePoll } from '@/lib/use-poll';

export interface Leaf {
  to: string;
  label: string;
  icon: LucideIcon;
  params?: { slug: string };
  exact?: boolean;
}
export interface Section {
  title: string;
  icon: LucideIcon;
  leaves: Leaf[];
  /** The runtime APPS block renders above this section. A flag rather than a title match, so renaming
   *  a section cannot silently move the block. */
  appsBefore?: boolean;
}

export const SECTIONS: Section[] = [
  {
    title: 'Environment',
    icon: Boxes,
    leaves: [
      { to: '/', label: 'Overview', icon: Gauge, exact: true },
      { to: '/stack', label: 'Stack', icon: Layers },
      { to: '/datastore', label: 'Datastore', icon: Database },
      { to: '/hub', label: 'Hub', icon: Webhook },
      { to: '/storage', label: 'Storage', icon: HardDrive },
      { to: '/fleet', label: 'Fleet', icon: Server },
      { to: '/layers', label: 'Layers', icon: Package },
    ],
  },
  {
    title: 'Testing',
    icon: FlaskConical,
    leaves: [
      { to: '/testing', label: 'Scenarios', icon: ListChecks },
      { to: '/results', label: 'Results', icon: ClipboardList },
    ],
  },
  {
    title: 'Configuration',
    icon: Cog,
    leaves: [
      // exact, or the Overview marker lights up on every /config/* page
      { to: '/config', label: 'Summary', icon: ClipboardList, exact: true },
      { to: '/config/stack', label: 'Stack knobs', icon: SlidersHorizontal },
      { to: '/config/fleet', label: 'Fleet nodes', icon: ServerCog },
      { to: '/config/zones', label: 'Zones & topology', icon: Network },
      { to: '/config/advanced', label: 'Advanced', icon: Wrench },
    ],
  },
  {
    title: 'Reference',
    icon: Library,
    appsBefore: true,
    leaves: [
      { to: '/docs', label: 'API docs', icon: FileCode },
      { to: '/audit', label: 'Audit log', icon: ScrollText },
      { to: '/getting-started', label: 'Getting started', icon: Rocket },
      { to: '/wiki/$slug', label: 'Bring up the stack', icon: Hash, params: { slug: 'bring-up' } },
      { to: '/wiki/$slug', label: 'Running the control center', icon: Hash, params: { slug: 'running-the-stack' } },
      { to: '/wiki', label: 'Browse all', icon: ArrowRight, exact: true },
    ],
  },
];

export function leafPath(l: Leaf): string {
  return l.params ? `/wiki/${l.params.slug}` : l.to;
}

/** The leaf's tour anchor. Exported because a tour step names it as a selector, so the guard that
 *  resolves those selectors has to derive them the same way this component renders them. */
export function leafAnchor(l: Leaf): string {
  return l.params ? `wiki-nav-${l.params.slug}` : `sidebar-${l.to.slice(1).replace(/\//g, '-')}`;
}

export function isLeafActive(pathname: string, l: Leaf): boolean {
  const path = leafPath(l);
  if (l.exact) return pathname === path;
  return pathname === path || pathname.startsWith(path + '/');
}

function sectionForPath(pathname: string): Section | undefined {
  return SECTIONS.find((s) => s.leaves.some((l) => isLeafActive(pathname, l)));
}

const LEAF_CLASS =
  'group/leaf relative flex w-full -translate-x-px items-center gap-2 rounded-none px-2 py-1.5 text-sm text-text-muted transition-colors hover:bg-hover-bg hover:text-text-primary';
const LEAF_ACTIVE_CLASS = 'font-medium text-accent-glow';

const LEAF_CONNECTOR_CLASS = cn(
  'group/leaf-item relative',
  'before:absolute before:top-0 before:left-[-8px] before:h-[14px] before:w-[6px] before:rounded-bl-[4px] before:border-b before:border-l before:border-sidebar-border',
  'after:absolute after:top-[14px] after:bottom-[-5px] after:left-[-8px] after:w-px after:bg-sidebar-border last:after:hidden',
);

function ActiveMarker() {
  return <span className="bg-accent ml-auto h-4 w-2 shrink-0 shadow-[0_0_4px_var(--color-accent-glow)]" />;
}

export function AppSidebar({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (v: boolean | ((p: boolean) => boolean)) => void;
}) {
  const { pathname } = useLocation();
  const activeSection = sectionForPath(pathname);

  return (
    <nav
      aria-label="Primary"
      data-tour="sidebar-rail"
      data-state={open ? 'expanded' : 'collapsed'}
      className={cn(
        'border-sidebar-border bg-sidebar flex shrink-0 flex-col overflow-hidden border-r transition-[width] duration-200',
        open ? 'w-64' : 'w-12',
      )}
    >
      <div
        data-tour="brand"
        className={cn(
          'border-sidebar-border flex h-16 shrink-0 items-center overflow-hidden border-b',
          open ? 'justify-start px-3' : 'justify-center px-2',
        )}
      >
        <SidebarWordmark collapsed={!open} />
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          const sectionActive = section === activeSection;

          const body = !open ? (
            <div className="group/rail relative">
              <button
                type="button"
                aria-label={section.title}
                onClick={() => setOpen(true)}
                data-active={sectionActive || undefined}
                className="text-sidebar-foreground hover:bg-accent/10 data-active:bg-accent data-active:text-primary-foreground relative flex size-8 items-center justify-center rounded-sm transition-colors"
              >
                <Icon className="size-4" />
                {sectionActive && (
                  <span className="bg-accent absolute top-1/2 -right-px h-4 w-[2px] -translate-y-1/2 shadow-[0_0_4px_var(--color-accent-glow)]" />
                )}
              </button>
              <span className="border-border-dim bg-bg-secondary text-text-primary pointer-events-none absolute top-1/2 left-full z-50 ml-2 -translate-y-1/2 rounded-sm border px-2 py-1 text-xs whitespace-nowrap opacity-0 shadow-xl transition-opacity group-hover/rail:opacity-100">
                {section.title}
              </span>
            </div>
          ) : (
            <div className="pt-1 first:pt-0">
              <div className="bg-sidebar-section-bg text-sidebar-foreground flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm font-bold">
                <Icon className="size-4 shrink-0" />
                <span className="truncate">/{section.title.toUpperCase()}/</span>
              </div>
              <div className="mt-0.5 ml-2.5 flex translate-x-px flex-col gap-0.5 py-0.5 pl-2">
                {section.leaves.map((l) => {
                  const LeafIcon = l.icon;
                  const active = isLeafActive(pathname, l);
                  const className = cn(LEAF_CLASS, active && LEAF_ACTIVE_CLASS);
                  const inner = (
                    <>
                      <LeafIcon className="size-3.5 shrink-0" />
                      <span className="truncate">{l.label}</span>
                      {active && <ActiveMarker />}
                    </>
                  );
                  const link = l.params ? (
                    <Link
                      to="/wiki/$slug"
                      params={{ slug: l.params.slug }}
                      data-tour={leafAnchor(l)}
                      title={l.label}
                      className={className}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <Link to={l.to} data-tour={leafAnchor(l)} title={l.label} className={className}>
                      {inner}
                    </Link>
                  );
                  return (
                    <div key={l.params ? `${l.to}:${l.params.slug}` : l.to} className={LEAF_CONNECTOR_CLASS}>
                      {link}
                    </div>
                  );
                })}
              </div>
            </div>
          );

          return (
            <Fragment key={section.title}>
              {section.appsBefore && <AppsSection open={open} setOpen={setOpen} />}
              {body}
            </Fragment>
          );
        })}
      </div>
    </nav>
  );
}

// Running web UIs, resolved from the process-catalog LAB_WEB_UI markers (listAppLinks); links use the
// browser's own hostname so they work over the LAN.
function useAppLinks(): { label: string; url: string; ready: boolean }[] {
  const appLinks = tsr.listAppLinks.useQuery({ queryKey: ['app-links'], refetchInterval: usePoll(5000) });
  const links = appLinks.data?.status === 200 ? appLinks.data.body : [];
  // Browser's own hostname reaches the LAN-facing services; a loopback-only UI targets localhost,
  // since telemetry.nix binds it loopback even under lan.expose (the LAN host would be a dead link).
  const lanHost = window.location.hostname;
  return links.map((l) => {
    const uiHost = l.loopback ? 'localhost' : lanHost;
    return { label: `${l.label} :${l.port}`, url: `http://${uiHost}:${l.port}${l.path}`, ready: l.ready };
  });
}

function AppsSection({ open, setOpen }: { open: boolean; setOpen: (v: boolean | ((p: boolean) => boolean)) => void }) {
  const links = useAppLinks();

  if (!open) {
    return (
      <div data-tour="sidebar-apps" className="group/rail relative">
        <button
          type="button"
          aria-label="Apps"
          onClick={() => setOpen(true)}
          className="text-sidebar-foreground hover:bg-accent/10 relative flex size-8 items-center justify-center rounded-sm transition-colors"
        >
          <AppWindow className="size-4" />
        </button>
        <span className="border-border-dim bg-bg-secondary text-text-primary pointer-events-none absolute top-1/2 left-full z-50 ml-2 -translate-y-1/2 rounded-sm border px-2 py-1 text-xs whitespace-nowrap opacity-0 shadow-xl transition-opacity group-hover/rail:opacity-100">
          Apps
        </span>
      </div>
    );
  }

  return (
    <div data-tour="sidebar-apps" className="pt-1">
      <div className="bg-sidebar-section-bg text-sidebar-foreground flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm font-bold">
        <AppWindow className="size-4 shrink-0" />
        <span className="truncate">/APPS/</span>
      </div>
      <div className="mt-0.5 ml-2.5 flex translate-x-px flex-col gap-0.5 py-0.5 pl-2">
        {links.length > 0 ? (
          links.map((l) => (
            <div key={l.url} className={LEAF_CONNECTOR_CLASS}>
              <a
                href={l.url}
                target="_blank"
                rel="noreferrer"
                title={`${l.url}${l.ready ? '' : ' — not ready yet'}`}
                className={cn(LEAF_CLASS, !l.ready && 'opacity-50')}
              >
                <ExternalLink className="size-3.5 shrink-0" />
                <span className="truncate">{l.label}</span>
              </a>
            </div>
          ))
        ) : (
          <div className="text-text-dim px-2 py-1 text-[11px]">Bring the stack up to see running web UIs.</div>
        )}
      </div>
    </div>
  );
}
