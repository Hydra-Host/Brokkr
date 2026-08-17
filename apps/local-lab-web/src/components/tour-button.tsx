import { useLocation, useRouter } from '@tanstack/react-router';
import { GraduationCap, Rocket, RotateCcw } from 'lucide-react';
import { useCallback, useEffect } from 'react';

export const DEPLOY_TOUR_EVENT = 'lab:start-deploy-tour';
export const OPS_TOUR_EVENT = 'lab:start-ops-tour';

import { Button } from '@/components/ui/button';
import {
  consumePendingResume,
  isTourActive,
  restartTour,
  shouldAutoLaunchTour,
  startDeployTour,
  startOpsTour,
  startTour,
  type TourNavigate,
} from '@/lib/tour';

function useRouterNavigate(): TourNavigate {
  const router = useRouter();
  // omit `search` entirely when the step has none — passing it as undefined clears the current params
  return useCallback(
    (to: string, search?: Record<string, string>) =>
      router.navigate((search ? { to, search } : { to }) as Parameters<typeof router.navigate>[0]),
    [router],
  );
}

function useStartTour() {
  const navigate = useRouterNavigate();
  return useCallback(() => startTour({ navigate }), [navigate]);
}

function useRestartTour() {
  const navigate = useRouterNavigate();
  return useCallback(() => restartTour({ navigate }), [navigate]);
}

function useStartDeployTour() {
  const navigate = useRouterNavigate();
  return useCallback(() => startDeployTour({ navigate }), [navigate]);
}

function useStartOpsTour() {
  const navigate = useRouterNavigate();
  return useCallback(() => startOpsTour({ navigate }), [navigate]);
}

export function TourButton() {
  const start = useStartTour();
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      data-tour="tour-button"
      onClick={start}
      className="gap-2"
      aria-label="Resume guided tour"
      title="Resume tour"
    >
      <GraduationCap className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Tour</span>
    </Button>
  );
}

export function RestartTourButton() {
  const restart = useRestartTour();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-tour="restart-button"
      onClick={restart}
      className="px-2"
      aria-label="Restart guided tour from the beginning"
      title="Restart tour"
    >
      <RotateCcw className="h-3.5 w-3.5" />
    </Button>
  );
}

export function DeployTourButton() {
  const start = useStartDeployTour();
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      data-tour="deploy-button"
      onClick={start}
      className="gap-2"
      aria-label="Start the guided deploy walkthrough"
      title="Guided deploy walkthrough"
    >
      <Rocket className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Guided Deploy</span>
    </Button>
  );
}

export function TourBootstrap() {
  const navigate = useRouterNavigate();
  const start = useStartTour();
  const startDeploy = useStartDeployTour();
  const startOps = useStartOpsTour();
  const pathname = useLocation({ select: (l) => l.pathname });

  // Skip wiki/guide routes (a new-tab wiki link must not be yanked back to /stack) and skip
  // while a tour is already running — pathname changes mid-tour must not restart it.
  useEffect(() => {
    if (isTourActive() || !shouldAutoLaunchTour(pathname)) return;
    const id = window.setTimeout(() => {
      if (!isTourActive() && shouldAutoLaunchTour(window.location.pathname)) start();
    }, 600);
    return () => window.clearTimeout(id);
  }, [pathname, start]);

  useEffect(() => {
    consumePendingResume({ navigate });
  }, [pathname, navigate]);

  useEffect(() => {
    const onDeploy = () => startDeploy();
    window.addEventListener(DEPLOY_TOUR_EVENT, onDeploy);
    return () => window.removeEventListener(DEPLOY_TOUR_EVENT, onDeploy);
  }, [startDeploy]);

  useEffect(() => {
    const onOps = () => startOps();
    window.addEventListener(OPS_TOUR_EVENT, onOps);
    return () => window.removeEventListener(OPS_TOUR_EVENT, onOps);
  }, [startOps]);

  return null;
}
