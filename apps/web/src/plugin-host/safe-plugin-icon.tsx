import { Component, type ReactNode } from 'react';

import type { NavIcon } from '~/lib/nav';

interface Props {
  pluginId: string;
  fallback: ReactNode;
  children: ReactNode;
}

interface State {
  errored: boolean;
}

class PluginIconErrorBoundary extends Component<Props, State> {
  state: State = { errored: false };

  static getDerivedStateFromError(): State {
    return { errored: true };
  }

  componentDidCatch(error: Error): void {
    console.error(`[plugin-host] plugin "${this.props.pluginId}" icon threw:`, error);
  }

  render(): ReactNode {
    return this.state.errored ? this.props.fallback : this.props.children;
  }
}

const wrappedIconCache = new WeakMap<NavIcon, WeakMap<NavIcon, Map<string, NavIcon>>>();

export function wrapPluginIcon(pluginId: string, Icon: NavIcon, Fallback: NavIcon): NavIcon {
  let byFallback = wrappedIconCache.get(Icon);
  if (!byFallback) {
    byFallback = new WeakMap();
    wrappedIconCache.set(Icon, byFallback);
  }
  let byPlugin = byFallback.get(Fallback);
  if (!byPlugin) {
    byPlugin = new Map();
    byFallback.set(Fallback, byPlugin);
  }
  const cached = byPlugin.get(pluginId);
  if (cached) return cached;

  function SafePluginIcon({ className }: { className?: string }) {
    return (
      <PluginIconErrorBoundary pluginId={pluginId} fallback={<Fallback className={className} />}>
        <Icon className={className} />
      </PluginIconErrorBoundary>
    );
  }
  byPlugin.set(pluginId, SafePluginIcon);
  return SafePluginIcon;
}
