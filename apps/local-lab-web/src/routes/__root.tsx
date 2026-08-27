import { createRootRoute, Link, Outlet, useLocation } from '@tanstack/react-router';
import { BookOpen, FileText, PanelLeft } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AppSidebar } from '@/components/app-sidebar';
import { BreadcrumbTypewriter, getBreadcrumbCrumbs } from '@/components/breadcrumb-typewriter';
import { CcBuildChip } from '@/components/cc-build-chip';
import { CcSkewBanner } from '@/components/cc-skew-banner';
import { ConnectivityDot, RecreatingBanner } from '@/components/recreating-banner';
import { DeployTourButton, RestartTourButton, TourBootstrap, TourButton } from '@/components/tour-button';
import { Button } from '@/components/ui/button';
import { ThemeSelector } from '@/components/ui/theme';
import { ToastProvider } from '@/lib/toast';
import { OPEN_SIDEBAR_EVENT, suspendActiveTourForNav } from '@/lib/tour';
import { ApplyConfirmProvider } from '@/lib/use-apply-confirm';
import { ApiDownProvider, apiIsDown } from '@/lib/use-poll';
import { useApiHealth } from '@/lib/use-restart-state';

function WikiButton() {
  return (
    <Button asChild variant="secondary" size="sm" className="gap-2">
      <Link
        to="/wiki"
        data-tour="wiki-button"
        data-tour-interactive=""
        onClick={() => suspendActiveTourForNav()}
        aria-label="Open the wiki"
        title="Wiki"
      >
        <BookOpen className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Wiki</span>
      </Link>
    </Button>
  );
}

function GuideButton() {
  return (
    <Button asChild variant="secondary" size="sm" className="gap-2">
      <Link
        to="/getting-started"
        data-tour="getting-started-button"
        data-tour-interactive=""
        onClick={() => suspendActiveTourForNav()}
        aria-label="Open the self-hosting guide"
        title="Get started - self hosting"
      >
        <FileText className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Get started - self hosting</span>
      </Link>
    </Button>
  );
}

function AppBreadcrumb() {
  const { pathname } = useLocation();
  const crumbs = getBreadcrumbCrumbs(pathname);
  if (!crumbs) return null;
  return <BreadcrumbTypewriter crumbs={crumbs} />;
}

function BrokkrShell() {
  const [open, setOpen] = useState(true);
  const health = useApiHealth();
  useEffect(() => {
    const onOpenSidebar = () => setOpen(true);
    window.addEventListener(OPEN_SIDEBAR_EVENT, onOpenSidebar);
    return () => window.removeEventListener(OPEN_SIDEBAR_EVENT, onOpenSidebar);
  }, []);
  return (
    <ApiDownProvider value={apiIsDown(health.banner)}>
      <div className="bg-bg-primary text-text-primary flex min-h-screen font-mono">
        <AppSidebar open={open} setOpen={setOpen} />
        <div className="content-plus-pattern flex min-w-0 flex-1 flex-col">
          <header className="relative z-30 flex h-12 shrink-0 items-center gap-3 bg-transparent px-3">
            <button
              type="button"
              data-tour="sidebar-toggle"
              aria-label={open ? 'Collapse menu' : 'Expand menu'}
              onClick={() => setOpen((o) => !o)}
              className="text-text-muted hover:bg-hover-bg hover:text-accent flex size-8 shrink-0 items-center justify-center rounded-sm transition-colors"
            >
              <PanelLeft className="size-4" />
            </button>
            <div className="min-w-0 flex-1">
              <AppBreadcrumb />
            </div>
            <div className="flex items-center gap-3">
              <CcBuildChip />
              <span className="text-text-dim hidden items-center gap-2 text-xs tracking-wide uppercase md:flex">
                <ConnectivityDot link={health.link} />
                testing control center
              </span>
              <GuideButton />
              <WikiButton />
              <span data-tour="tour-controls" className="flex items-center gap-3">
                <TourButton />
                <RestartTourButton />
              </span>
              <DeployTourButton />
              <span data-tour="skin-picker" data-tour-interactive="">
                <ThemeSelector />
              </span>
            </div>
          </header>
          <CcSkewBanner />
          <RecreatingBanner banner={health.banner} />
          <main className="min-w-0 flex-1 overflow-auto p-4 sm:p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </ApiDownProvider>
  );
}

export const Route = createRootRoute({
  component: () => (
    <ToastProvider>
      <ApplyConfirmProvider>
        <TourBootstrap />
        <BrokkrShell />
      </ApplyConfirmProvider>
    </ToastProvider>
  ),
});
