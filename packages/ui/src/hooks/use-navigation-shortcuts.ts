import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { getHelpdeskUrl } from '../lib/brand';

export interface NavigationShortcut {
  key: string;
  cmd: boolean;
  shift: boolean;
  route: string;
  display: string;
  isExternal?: boolean;
}

export const navigationShortcuts: Record<string, NavigationShortcut> = {
  'rentals.deployments': {
    key: 'p',
    cmd: true,
    shift: true,
    route: '/deployments',
    display: '\u21e7\u2318P',
  },
  'rentals.monitoring': {
    key: 'o',
    cmd: true,
    shift: true,
    route: '/deployments/monitoring',
    display: '\u21e7\u2318O',
  },

  'inventory.servers': {
    key: 's',
    cmd: true,
    shift: true,
    route: '/inventory',
    display: '\u21e7\u2318S',
  },

  'helpdesk.ticket-portal': {
    key: 'x',
    cmd: true,
    shift: true,
    route: '',
    display: '\u21e7\u2318X',
    isExternal: true,
  },
  'helpdesk.new-ticket': {
    key: 'h',
    cmd: true,
    shift: true,
    route: '/helpdesk/new-ticket',
    display: '\u21e7\u2318H',
  },

  docs: {
    key: '/',
    cmd: true,
    shift: true,
    route: '/docs/brokkr-overview',
    display: '\u21e7\u2318/',
  },

  'monetization.dashboard': {
    key: 'y',
    cmd: true,
    shift: true,
    route: '/dcim/dashboard',
    display: '\u21e7\u2318Y',
  },
  'dcim.zones': {
    key: 'z',
    cmd: true,
    shift: true,
    route: '/dcim/zones',
    display: '\u21e7\u2318Z',
  },
  'dcim.bridges': {
    key: 'e',
    cmd: true,
    shift: true,
    route: '/dcim/bridges',
    display: '\u21e7\u2318E',
  },
  'dcim.devices': {
    key: 'l',
    cmd: true,
    shift: true,
    route: '/dcim/devices',
    display: '\u21e7\u2318L',
  },
  'dcim.monitoring': {
    key: 'M',
    cmd: true,
    shift: true,
    route: '/dcim/monitoring',
    display: '\u21e7\u2318M',
  },

  'org.billing': {
    key: 'j',
    cmd: true,
    shift: true,
    route: '/organizations/billing',
    display: '\u21e7\u2318J',
  },
  'org.members': {
    key: 'm',
    cmd: true,
    shift: true,
    route: '/organizations/members',
    display: '\u21e7\u2318M',
  },
  'org.api-keys': {
    key: '[',
    cmd: true,
    shift: true,
    route: '/organizations/api-keys',
    display: '\u21e7\u2318[',
  },
  'org.webhooks': {
    key: ']',
    cmd: true,
    shift: true,
    route: '/organizations/webhooks',
    display: '\u21e7\u2318]',
  },
  'org.settings': {
    key: ',',
    cmd: true,
    shift: true,
    route: '/organizations/settings',
    display: '\u21e7\u2318,',
  },
};

export function getShortcutByRoute(route: string): string | undefined {
  const entry = Object.values(navigationShortcuts).find((s) => s.route === route);
  return entry?.display;
}

export function useNavigationShortcuts(enabled: boolean = true) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const cmdKey = isMac ? e.metaKey : e.ctrlKey;

      if (!cmdKey || !e.shiftKey) return;

      for (const shortcut of Object.values(navigationShortcuts)) {
        if (e.key.toLowerCase() === shortcut.key.toLowerCase()) {
          e.preventDefault();
          e.stopPropagation();

          if (shortcut.isExternal) {
            const externalUrl = shortcut.route || getHelpdeskUrl();
            if (externalUrl) window.open(externalUrl, '_blank');
          } else {
            navigate({ to: shortcut.route });
          }
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled, navigate]);
}
