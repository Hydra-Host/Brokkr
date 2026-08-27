import { driver, type Driver, type DriveStep } from 'driver.js';

import { DEPLOY_STEPS, OPS_STEPS, ORIENTATION_STEPS, type TourStep } from '@/lib/tour-steps';

export const TOUR_SEEN_KEY = 'lab-tour-seen';

export const OPEN_SIDEBAR_EVENT = 'lab:open-sidebar';
const ORIENTATION_STEP_KEY = 'lab-tour-step';
const ORIENTATION_RESUME_KEY = 'lab-tour-resume';
const DEPLOY_STEP_KEY = 'lab-deploy-step';
const DEPLOY_RESUME_KEY = 'lab-deploy-resume';
const OPS_STEP_KEY = 'lab-ops-step';
const OPS_RESUME_KEY = 'lab-ops-resume';

/** Whether the orientation tour has already been shown (started, completed, or skipped).
 *  Shared via localStorage so a wiki new-tab can't auto-launch a second copy. */
export function hasSeenTour(): boolean {
  try {
    return !!localStorage.getItem(TOUR_SEEN_KEY);
  } catch {
    return true;
  }
}

/** Suppress future first-visit auto-launch (cross-tab via localStorage). */
export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, '1');
  } catch (error) {
    console.debug('tour mark-seen failed', error);
  }
}

// The tour's global key handler must yield to editable controls so typing
// Space/Arrows/Esc into a field isn't hijacked into advancing/exiting the tour.
export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable === true
  );
}

interface TourKeyActions {
  endPeek: () => void;
  clearExitHint: () => void;
  pause: () => void;
  advance: () => void;
  back: () => void;
}

export function handleTourKeydown(ev: KeyboardEvent, actions: TourKeyActions): void {
  if (isEditableEventTarget(ev.target)) return;
  // while minimized, any tour key just restores the slide (never advance/exit).
  if (document.body.classList.contains('tour-peek')) {
    if (
      ev.key === 'Escape' ||
      ev.key === ' ' ||
      ev.key === 'Spacebar' ||
      ev.key === 'ArrowRight' ||
      ev.key === 'ArrowLeft'
    ) {
      ev.preventDefault();
      actions.endPeek();
    }
    return;
  }
  if (ev.key === 'Escape') {
    ev.preventDefault();
    actions.pause();
  } else if (ev.key === ' ' || ev.key === 'Spacebar' || ev.key === 'ArrowRight') {
    ev.preventDefault();
    actions.clearExitHint();
    actions.advance();
  } else if (ev.key === 'ArrowLeft') {
    ev.preventDefault();
    actions.clearExitHint();
    actions.back();
  }
}

function saveStep(key: string, index: number): void {
  try {
    localStorage.setItem(key, String(index));
  } catch (error) {
    console.debug('tour step save failed', error);
  }
}

function readSavedStep(key: string): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function clearSavedStep(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.debug('tour step clear failed', error);
  }
}

function setResumeMarker(key: string, index: number): void {
  try {
    sessionStorage.setItem(key, String(index));
  } catch (error) {
    console.debug('tour resume-marker save failed', error);
  }
}

function peekResumeMarker(key: string): number | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw == null) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function clearResumeMarker(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch (error) {
    console.debug('tour resume-marker clear failed', error);
  }
}

export function reportMissingAnchor(index: number, selector: string | undefined, pathname: string): void {
  if (!selector) return;
  console.error(`tour step ${index} never found ${selector} on ${pathname}`);
}

export type TourNavigate = (path: string, search?: Record<string, string>) => Promise<unknown> | void;

function showReopenHint(anchorSelector = '[data-tour="tour-button"]', label = 'Reopen the tour here anytime'): void {
  document.querySelectorAll('.brokkr-tour-reopen-cue').forEach((el) => el.remove());
  const anchor = document.querySelector(anchorSelector) ?? document.querySelector('[data-tour="tour-button"]');
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();

  const cue = document.createElement('div');
  cue.className = 'brokkr-tour-reopen-cue';
  cue.style.left = `${r.left + r.width / 2}px`;
  cue.style.top = `${r.bottom + 6}px`;

  const arrow = document.createElement('span');
  arrow.className = 'brokkr-tour-reopen-arrow';
  arrow.textContent = '▲';

  const pill = document.createElement('div');
  pill.className = 'brokkr-tour-reopen-label';
  const text = document.createElement('span');
  text.textContent = label;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'brokkr-tour-reopen-x';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';
  pill.append(text, close);
  cue.append(arrow, pill);
  document.body.appendChild(cue);

  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    document.removeEventListener('keydown', onEsc, true);
    cue.remove();
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  };
  close.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  });
  document.addEventListener('keydown', onEsc, true);
  const timer = window.setTimeout(dismiss, 5000);
}

/** Resolves true when the selector matched. False means the popover will render unanchored, which is
 *  otherwise silent — `reportMissingAnchor` is the only signal a step has gone stale. */
function waitForEl(selector: string | undefined, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!selector) {
      resolve(true);
      return;
    }
    const start = performance.now();
    const tick = () => {
      if (document.querySelector(selector)) {
        resolve(true);
        return;
      }
      if (performance.now() - start > timeout) {
        resolve(false);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function stepNeedsSidebarOpen(step: TourStep | undefined): boolean {
  const el = step?.element;
  if (!el || !el.includes('data-tour="sidebar-')) return false;
  return !el.includes('sidebar-rail') && !el.includes('sidebar-toggle');
}

// subset match, not string equality: the router keeps unrelated params (a selected jobId, a filter)
// and writes them in its own order, so an exact compare would re-navigate on every step.
function atStepRoute(step: TourStep | undefined): boolean {
  if (!step?.route) return true;
  if (window.location.pathname !== step.route) return false;
  const current = new URLSearchParams(window.location.search);
  return Object.entries(step.search ?? {}).every(([key, value]) => current.get(key) === value);
}

function ensureSidebarOpen(step: TourStep | undefined): void {
  if (!stepNeedsSidebarOpen(step)) return;
  try {
    window.dispatchEvent(new CustomEvent(OPEN_SIDEBAR_EVENT));
  } catch (error) {
    console.debug('tour open-sidebar dispatch failed', error);
  }
}

let active: { obj: Driver; stepKey?: string; resumeKey?: string } | null = null;

export function isTourActive(): boolean {
  return active != null;
}

export function suspendActiveTourForNav(): void {
  if (!active) return;
  const i = active.obj.getActiveIndex() ?? 0;
  if (active.stepKey) saveStep(active.stepKey, i);
  if (active.resumeKey) setResumeMarker(active.resumeKey, i);
  active.obj.destroy();
}

interface RunTourOptions {
  allowInteraction?: boolean;
  stepKey?: string;
  resumeKey?: string;
  /** Mark the orientation tour seen on start (and again on exit) so other tabs
   *  don't auto-launch a duplicate while this one is still running. */
  markSeen?: boolean;
  reopenAnchor?: string;
  reopenLabel?: string;
  startIndex?: number;
}

function runTour(steps: TourStep[], navigate: TourNavigate, opts: RunTourOptions = {}): void {
  if (active) active.obj.destroy();
  // every deck's marker, not just this one's: a marker left by another deck would hijack the next
  // navigation and swap the user into a tour they did not start.
  clearResumeMarker(ORIENTATION_RESUME_KEY);
  clearResumeMarker(DEPLOY_RESUME_KEY);
  clearResumeMarker(OPS_RESUME_KEY);
  // Mark seen immediately (not only on Skip/complete) so a wiki new-tab that
  // later navigates to /stack can't auto-launch a second orientation tour.
  if (opts.markSeen) markTourSeen();

  // eslint-disable-next-line prefer-const
  let obj: Driver;

  const idx = () => obj.getActiveIndex() ?? 0;

  const advance = () => {
    if (obj.isLastStep()) {
      if (opts.stepKey) clearSavedStep(opts.stepKey);
      if (opts.markSeen) markTourSeen();
      obj.destroy();
      return;
    }
    void goToStep(idx() + 1);
  };
  const back = () => {
    const prev = idx() - 1;
    if (prev >= 0) void goToStep(prev);
  };
  const pause = () => {
    if (opts.stepKey) saveStep(opts.stepKey, idx());
    if (opts.markSeen) markTourSeen();
    obj.destroy();
    showReopenHint(opts.reopenAnchor, opts.reopenLabel);
  };

  let exitArmed = false;
  let exitEls: HTMLElement[] = [];
  let exitTimer = 0;
  let savedPopoverStyle: string | null = null;

  const endPeek = () => {
    if (!document.body.classList.contains('tour-peek')) return;
    document.body.classList.remove('tour-peek');
    const pop = document.querySelector<HTMLElement>('.driver-popover');
    if (pop && savedPopoverStyle != null) pop.style.cssText = savedPopoverStyle;
    savedPopoverStyle = null;
  };

  const peek = () => {
    if (document.body.classList.contains('tour-peek')) return;
    const pop = document.querySelector<HTMLElement>('.driver-popover');
    const activeEl = document.querySelector('.driver-active-element');
    document.body.classList.add('tour-peek');
    if (pop && activeEl) {
      savedPopoverStyle = pop.style.cssText;
      const r = activeEl.getBoundingClientRect();
      pop.style.setProperty('top', `${Math.round(r.bottom + 8)}px`, 'important');
      pop.style.setProperty('left', `${Math.round(r.left)}px`, 'important');
      pop.style.setProperty('right', 'auto', 'important');
      pop.style.setProperty('bottom', 'auto', 'important');
    }
  };

  const clearExitHint = () => {
    exitArmed = false;
    if (exitTimer) {
      window.clearTimeout(exitTimer);
      exitTimer = 0;
    }
    exitEls.forEach((el) => el.remove());
    exitEls = [];
  };

  const showExitConfirm = (x: number, y: number) => {
    clearExitHint();
    exitArmed = true;

    const tip = document.createElement('div');
    tip.className = 'brokkr-tour-exit-tip';
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.textContent = 'Click again (or press Esc) to exit the tour';
    document.body.appendChild(tip);
    exitEls.push(tip);

    exitTimer = window.setTimeout(clearExitHint, 6000);
  };

  // keyboard: we drive it ourselves (driver.js keyboard control is disabled) so
  // the tour responds wherever focus lands, except editable fields (see handler).
  const onKey = (ev: KeyboardEvent) => handleTourKeydown(ev, { endPeek, clearExitHint, pause, advance, back });

  const onDocClick = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    if (document.body.classList.contains('tour-peek')) {
      if (target.closest('.driver-popover')) {
        ev.preventDefault();
        ev.stopPropagation();
        endPeek();
      }
      return;
    }

    // Wiki term: let the browser honor target="_blank" (one new tab); stopPropagation only —
    // preventDefault or window.open would open a second tab or exit the tour.
    const termEl = target.closest<HTMLAnchorElement>('a.wiki-term[data-wiki]');
    if (termEl) {
      clearExitHint();
      ev.stopPropagation();
      return;
    }

    if (target.closest('.driver-overlay')) {
      ev.preventDefault();
      ev.stopPropagation();
      if (exitArmed) pause();
      else showExitConfirm(ev.clientX, ev.clientY);
      return;
    }

    if (steps[idx()]?.peekOnClick && target.closest('.driver-active-element')) {
      clearExitHint();
      peek();
      return;
    }

    if (exitArmed) clearExitHint();
  };

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('click', onDocClick, true);
  document.body.classList.add('tour-running');

  const cleanup = () => {
    clearExitHint();
    endPeek();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onDocClick, true);
    document.body.classList.remove('tour-running');
  };

  const goToStep = async (index: number) => {
    const step = steps[index];
    if (!step) return;
    if (step.route && !atStepRoute(step)) {
      await navigate(step.route, step.search);
    }
    ensureSidebarOpen(step);
    const found = await waitForEl(step.element, step.route || stepNeedsSidebarOpen(step) ? 900 : 0);
    if (!found) reportMissingAnchor(index, step.element, window.location.pathname);
    obj.moveTo(index);
  };

  const driveSteps: DriveStep[] = steps.map((s) => ({
    element: s.element,
    popover: {
      title: s.title,
      description: s.description,
      side: s.side,
      align: s.align,
    },
  }));

  obj = driver({
    steps: driveSteps,
    popoverClass: 'brokkr-tour',
    showProgress: true,
    progressText: '{{current}} / {{total}}',
    nextBtnText: 'Next →',
    prevBtnText: '← Back',
    doneBtnText: 'Done',
    allowClose: false,
    allowKeyboardControl: false,
    disableActiveInteraction: !opts.allowInteraction,
    showButtons: ['next', 'previous'],
    overlayColor: '#05040a',
    overlayOpacity: 0.7,
    stagePadding: 6,
    stageRadius: 2,
    smoothScroll: true,
    onNextClick: advance,
    onPrevClick: back,
    onPopoverRender: (popover) => {
      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'brokkr-tour-skip';
      skip.textContent = 'Skip';
      skip.addEventListener('click', () => pause());
      popover.footerButtons.insertBefore(skip, popover.footerButtons.firstChild);
    },
    onDestroyed: () => {
      cleanup();
      if (active?.obj === obj) active = null;
    },
  });

  active = { obj, stepKey: opts.stepKey, resumeKey: opts.resumeKey };

  const startIndex = opts.startIndex && opts.startIndex < steps.length ? opts.startIndex : 0;
  void (async () => {
    const first = steps[startIndex];
    if (first?.route && !atStepRoute(first)) {
      await navigate(first.route, first.search);
    }
    ensureSidebarOpen(first);
    const found = await waitForEl(first?.element, first?.route || stepNeedsSidebarOpen(first) ? 900 : 0);
    if (!found) reportMissingAnchor(startIndex, first?.element, window.location.pathname);
    obj.drive(startIndex);
  })();
}

const ORIENTATION_OPTS = {
  stepKey: ORIENTATION_STEP_KEY,
  resumeKey: ORIENTATION_RESUME_KEY,
  markSeen: true,
  reopenAnchor: '[data-tour="tour-button"]',
  reopenLabel: 'Reopen the tour here anytime',
} as const;

const DEPLOY_OPTS = {
  allowInteraction: true,
  stepKey: DEPLOY_STEP_KEY,
  resumeKey: DEPLOY_RESUME_KEY,
  reopenAnchor: '[data-tour="deploy-button"]',
  reopenLabel: 'Reopen the deploy walkthrough here',
} as const;

// no reopenAnchor: the ops deck has no header button, so the hint falls back to the tour button.
const OPS_OPTS = {
  allowInteraction: true,
  stepKey: OPS_STEP_KEY,
  resumeKey: OPS_RESUME_KEY,
  reopenLabel: 'Reopen the operations walkthrough from the wiki',
} as const;

export function startTour({ navigate }: { navigate: TourNavigate }): void {
  runTour(ORIENTATION_STEPS, navigate, { ...ORIENTATION_OPTS, startIndex: readSavedStep(ORIENTATION_STEP_KEY) });
}

export function restartTour({ navigate }: { navigate: TourNavigate }): void {
  clearSavedStep(ORIENTATION_STEP_KEY);
  runTour(ORIENTATION_STEPS, navigate, { ...ORIENTATION_OPTS, startIndex: 0 });
}

export function startDeployTour({ navigate }: { navigate: TourNavigate }): void {
  runTour(DEPLOY_STEPS, navigate, { ...DEPLOY_OPTS, startIndex: readSavedStep(DEPLOY_STEP_KEY) });
}

export function startOpsTour({ navigate }: { navigate: TourNavigate }): void {
  runTour(OPS_STEPS, navigate, { ...OPS_OPTS, startIndex: readSavedStep(OPS_STEP_KEY) });
}

function isSuspendNavRoute(pathname: string): boolean {
  return pathname.startsWith('/wiki') || pathname.startsWith('/getting-started');
}

/** First-visit auto-launch — skip wiki/guide pages so a new-tab wiki link isn't
 *  yanked back to /stack by the orientation tour's first step. */
export function shouldAutoLaunchTour(pathname: string): boolean {
  return !hasSeenTour() && !isSuspendNavRoute(pathname);
}

export function consumePendingResume({ navigate }: { navigate: TourNavigate }): boolean {
  if (active) return false;
  if (isSuspendNavRoute(window.location.pathname)) return false;

  const opsIdx = peekResumeMarker(OPS_RESUME_KEY);
  if (opsIdx != null) {
    clearResumeMarker(OPS_RESUME_KEY);
    runTour(OPS_STEPS, navigate, { ...OPS_OPTS, startIndex: opsIdx });
    return true;
  }

  const deployIdx = peekResumeMarker(DEPLOY_RESUME_KEY);
  if (deployIdx != null) {
    clearResumeMarker(DEPLOY_RESUME_KEY);
    runTour(DEPLOY_STEPS, navigate, { ...DEPLOY_OPTS, startIndex: deployIdx });
    return true;
  }

  const orientIdx = peekResumeMarker(ORIENTATION_RESUME_KEY);
  if (orientIdx != null) {
    clearResumeMarker(ORIENTATION_RESUME_KEY);
    runTour(ORIENTATION_STEPS, navigate, { ...ORIENTATION_OPTS, startIndex: orientIdx });
    return true;
  }
  return false;
}
