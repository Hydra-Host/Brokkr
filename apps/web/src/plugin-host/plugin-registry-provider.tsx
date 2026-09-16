import { useSession } from '@repo/auth/client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { useActiveOrganizationId } from '~/hooks/use-active-organization-id';

import type { CorePathMatcher } from './public-routes';
import { EMPTY_PLUGIN_REGISTRY, loadPluginRegistry, type PluginRegistry } from './registry';

const PluginRegistryContext = createContext<PluginRegistry | null>(null);

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  isCorePath: CorePathMatcher;
}

const EMPTY_REGISTRY = EMPTY_PLUGIN_REGISTRY;

export function PluginRegistryProvider({ children, fallback, isCorePath }: Props) {
  const [loaded, setLoaded] = useState<{ identityKey: string; registry: PluginRegistry } | null>(null);
  const { data: session } = useSession();
  const activeOrgId = useActiveOrganizationId();

  const identityKey = session ? `${session.user.id}:${activeOrgId ?? ''}` : 'anon';

  useEffect(() => {
    let cancelled = false;
    loadPluginRegistry(isCorePath)
      .then((registry) => {
        if (!cancelled) setLoaded({ identityKey, registry });
      })
      .catch((err: unknown) => {
        console.error('[plugin-host] registry load failed:', err);
        if (!cancelled) setLoaded({ identityKey, registry: EMPTY_PLUGIN_REGISTRY });
      });
    return () => {
      cancelled = true;
    };
  }, [identityKey, isCorePath]);

  if (loaded === null) {
    return <>{fallback ?? null}</>;
  }
  // On identity change serve EMPTY (stale registry could leak operator-only slots/routes) but stay mounted (unmounting drops in-flight navigation, e.g. the 2FA post-verify redirect).
  const registry = loaded.identityKey === identityKey ? loaded.registry : EMPTY_REGISTRY;
  return <PluginRegistryContext.Provider value={registry}>{children}</PluginRegistryContext.Provider>;
}

export function usePluginRegistry(): PluginRegistry {
  const registry = useContext(PluginRegistryContext);
  if (!registry) {
    throw new Error('usePluginRegistry must be used inside <PluginRegistryProvider>');
  }
  return registry;
}
