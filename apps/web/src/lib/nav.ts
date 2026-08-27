import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

export type NavIcon = React.ComponentType<{ className?: string }>;

export interface NavLeaf {
  title: string;
  url: string;
  icon: NavIcon;
  external?: boolean;
  /** Open in a named popup window (re-focused on later clicks) instead of navigating. */
  popup?: boolean;
}

export interface NavSection {
  title: string;
  icon: NavIcon;
  items: NavLeaf[];
}

export interface FlatLeaf extends NavLeaf {
  sectionTitle: string | null;
}

export function isLeafActive(pathname: string, url: string): boolean {
  if (url === '/') return pathname === '/';
  return pathname === url || pathname.startsWith(url + '/');
}

function isProtocolRelative(to: string): boolean {
  return to.startsWith('//') || to.startsWith('/\\');
}

export function safeExternalHref(to: string): string | undefined {
  if (/^https?:\/\//i.test(to)) return to;
  return to.startsWith('/') && !isProtocolRelative(to) ? to : undefined;
}

export function safeInternalPath(to: string): string | undefined {
  return to.startsWith('/') && !isProtocolRelative(to) ? to : undefined;
}

export function mergeNavSections(host: NavSection[], plugin: NavSection[]): NavSection[] {
  const merged = host.map((section) => ({ ...section, items: [...section.items] }));
  for (const extra of plugin) {
    const existing = merged.find((section) => section.title.toLowerCase() === extra.title.toLowerCase());
    if (existing) {
      existing.items.push(...extra.items);
      continue;
    }
    merged.push({ ...extra, items: [...extra.items] });
  }
  return merged;
}

export function followInternalNavClick(
  event: {
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    button: number;
    preventDefault: () => void;
  },
  href: string,
  push: (href: string) => void,
): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return;
  }
  event.preventDefault();
  push(href);
}

// Keyed by URL: re-clicking a popup leaf must not re-navigate the running window —
// a reload would destroy its state (e.g. a booted WebVM).
const navPopups = new Map<string, Window>();

// The popup document claims this Web Lock with `ifAvailable` on load and self-closes if a live
// instance holds it — atomic grant-or-deny, no probe-then-act race; auto-releases on close/crash.
export function navPopupLockName(url: string): string {
  return `nav-popup:${url}`;
}

// Canonical form used for EVERY liveness key (lock, channel messages, registries): the server
// serves popup documents at '/x', '/x/', and '/x.html', so both sides must normalize to match.
function canonicalNavPopupPath(url: string): string {
  return url.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
}

// BroadcastChannel is origin-scoped like the Web Lock, so it crosses the COOP boundary that
// severs window handles — the only way an opener can still talk to a live isolated popup.
type NavPopupMessage = { type: 'opened' | 'closed' | 'pong' | 'focus' | 'ping' | 'announce'; url: string };

function isNavPopupMessage(value: unknown): value is NavPopupMessage {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value) || !('url' in value)) return false;
  return (
    typeof value.url === 'string' &&
    typeof value.type === 'string' &&
    ['opened', 'closed', 'pong', 'focus', 'ping', 'announce'].includes(value.type)
  );
}

// Opener-side liveness registry: lets a re-click send 'focus' to a live isolated window
// instead of spawning a flash window that self-closes on the lock.
const livePopupUrls = new Set<string>();
// Watchdog per focus attempt: a crashed popup (never sent 'closed') stays registered; if a
// 'ping' gets no 'pong' in time, drop it so the next click reopens instead of focusing a ghost.
const stalePopupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearStaleTimer(url: string): void {
  const timer = stalePopupTimers.get(url);
  if (timer) {
    clearTimeout(timer);
    stalePopupTimers.delete(url);
  }
}

const navPopupChannel: BroadcastChannel | null =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('nav-popup');
if (navPopupChannel) {
  navPopupChannel.addEventListener('message', (event) => {
    if (!isNavPopupMessage(event.data)) return;
    const { type, url } = event.data;
    if (type === 'opened' || type === 'pong') {
      livePopupUrls.add(url);
      clearStaleTimer(url);
    } else if (type === 'closed') {
      livePopupUrls.delete(url);
      clearStaleTimer(url);
    }
  });
  navPopupChannel.postMessage({ type: 'announce', url: '*' });
}

// Awaited by the popup document BEFORE mounting (see webvm-terminal-main.tsx): true = this window
// is the live instance (lock held until close/crash); false = don't boot, window.close().
export function claimNavPopupLock(): Promise<boolean> {
  // A non-isolated document can't run its isolated payload and must not read as "already open";
  // every engine recent enough for cross-origin isolation ships navigator.locks.
  if (!navigator.locks || !window.crossOriginIsolated) return Promise.resolve(true);
  const canonicalPath = canonicalNavPopupPath(window.location.pathname);
  return new Promise((resolve) => {
    void navigator.locks.request(navPopupLockName(canonicalPath), { ifAvailable: true }, (lock) => {
      if (!lock) {
        // Duplicate window — ask the live instance to come to the front before dying.
        navPopupChannel?.postMessage({ type: 'focus', url: canonicalPath });
        resolve(false);
        return;
      }
      if (navPopupChannel) {
        navPopupChannel.addEventListener('message', (event) => {
          if (!isNavPopupMessage(event.data)) return;
          const { type, url } = event.data;
          if (type === 'announce') {
            navPopupChannel.postMessage({ type: 'opened', url: canonicalPath });
          } else if (url !== canonicalPath) {
            return;
          } else if (type === 'ping') {
            navPopupChannel.postMessage({ type: 'pong', url: canonicalPath });
          } else if (type === 'focus') {
            // Best effort: browsers may refuse a programmatic raise without
            // user activation in THIS window; the opener's toast covers that.
            window.focus();
          }
        });
        navPopupChannel.postMessage({ type: 'opened', url: canonicalPath });
        window.addEventListener('pagehide', () => {
          navPopupChannel.postMessage({ type: 'closed', url: canonicalPath });
        });
      }
      resolve(true);
      // Never resolves — the lock is held until the window closes or crashes.
      return new Promise(() => {});
    });
  });
}

// 'opened' covers both a fresh window and focusing a still-reachable one; 'focused' means a
// live isolated window was asked to come to the front; 'blocked' means the browser refused.
export type OpenNavPopupResult = 'opened' | 'focused' | 'blocked';

// Single copy for every popup click site: a blocked popup otherwise fails silently, and a
// 'focused' window may decline the programmatic raise, so tell the user where it lives.
export function notifyNavPopupResult(result: OpenNavPopupResult, label: string): void {
  if (result === 'blocked') {
    toast.error(`The browser blocked the ${label} window. Allow popups for this site and try again.`);
  } else if (result === 'focused') {
    toast(`${label} is already open in another window.`);
  }
}

// Synchronous on purpose: `window.open` must run inside the click's user-gesture (awaiting
// anything first makes Firefox/Safari block it); duplicate detection is the popup's self-close.
export function openNavPopup(url: string): OpenNavPopupResult {
  const canonicalPath = canonicalNavPopupPath(url);
  // Fast path: a still-reachable handle (non-isolated docs, or isolated ones until their COOP
  // navigation commits) — also collapses a rapid double-click onto the first window.
  const existing = navPopups.get(canonicalPath);
  if (existing && !existing.closed) {
    existing.focus();
    return 'opened';
  }
  // A live isolated window (severed handle, but registered via the channel): ask it to focus
  // itself; the paired ping arms the stale watchdog so a crashed popup gets dropped.
  if (navPopupChannel && livePopupUrls.has(canonicalPath)) {
    navPopupChannel.postMessage({ type: 'focus', url: canonicalPath });
    navPopupChannel.postMessage({ type: 'ping', url: canonicalPath });
    // Never reset a pending watchdog: rapid re-clicks would push the deadline out and a ghost
    // entry would never expire. The first unanswered ping wins; a live pong clears the timer.
    if (!stalePopupTimers.has(canonicalPath)) {
      stalePopupTimers.set(
        canonicalPath,
        setTimeout(() => {
          stalePopupTimers.delete(canonicalPath);
          livePopupUrls.delete(canonicalPath);
        }, 2000),
      );
    }
    return 'focused';
  }
  // Named reuse can NOT navigate a running isolated popup (COOP moved it to another browsing
  // context group), so this open() lands in a fresh window that self-closes on the popup lock.
  const name = 'boss-popup-' + canonicalPath.replace(/[^a-zA-Z0-9]/g, '-');
  const win = window.open(url, name, 'popup=yes,width=1024,height=720,resizable=yes,scrollbars=no');
  if (!win) return 'blocked';
  navPopups.set(canonicalPath, win);
  return 'opened';
}

function sharedSegmentCount(a: string, b: string): number {
  const as = a.split('/').filter(Boolean);
  const bs = b.split('/').filter(Boolean);
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

export function getSectionForPathname(sections: NavSection[], pathname: string): NavSection | null {
  let exact: { section: NavSection; length: number } | null = null;
  let prefix: { section: NavSection; segments: number } | null = null;
  for (const section of sections) {
    for (const leaf of section.items) {
      if (isLeafActive(pathname, leaf.url) && leaf.url.length > (exact?.length ?? -1)) {
        exact = { section, length: leaf.url.length };
      }
      const segments = sharedSegmentCount(pathname, leaf.url);
      if (segments > 0 && segments > (prefix?.segments ?? 0)) {
        prefix = { section, segments };
      }
    }
  }
  return exact?.section ?? prefix?.section ?? null;
}

export function getVisibleLeaves(sections: NavSection[]): FlatLeaf[] {
  return sections.flatMap((section) => section.items.map((leaf) => ({ ...leaf, sectionTitle: section.title })));
}

export function findLeafByUrl(sections: NavSection[], url: string): FlatLeaf | null {
  return getVisibleLeaves(sections).find((leaf) => leaf.url === url) ?? null;
}

const PINNED_STORAGE_KEY = 'web:pinned-leaves';

function readPinnedFromStorage(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PINNED_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

export function usePinnedLeaves(): {
  pinnedUrls: string[];
  isPinned: (url: string) => boolean;
  togglePin: (url: string) => void;
  reorderPin: (fromUrl: string, toUrl: string, position: 'above' | 'below') => void;
} {
  const [pinnedUrls, setPinnedUrls] = useState<string[]>(() => readPinnedFromStorage());

  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pinnedUrls));
    } catch (error) {
      console.info('Failed to persist pinned leaves', error);
    }
  }, [pinnedUrls]);

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === PINNED_STORAGE_KEY) setPinnedUrls(readPinnedFromStorage());
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const togglePin = useCallback((url: string) => {
    setPinnedUrls((prev) => (prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url]));
  }, []);

  const reorderPin = useCallback((fromUrl: string, toUrl: string, position: 'above' | 'below') => {
    setPinnedUrls((prev) => {
      const fromIdx = prev.indexOf(fromUrl);
      const toIdx = prev.indexOf(toUrl);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
      const targetIdx = toIdx + (position === 'below' ? 1 : 0);
      const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx;
      if (insertIdx === fromIdx) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(insertIdx, 0, moved!);
      return next;
    });
  }, []);

  const isPinned = useCallback((url: string) => pinnedUrls.includes(url), [pinnedUrls]);

  return { pinnedUrls, isPinned, togglePin, reorderPin };
}
