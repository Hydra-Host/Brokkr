export interface ServerTab<G extends string = string> {
  name: string;
  /** Path segment after the base path; '' is the landing tab. */
  segment: string;
  gate?: G;
}

export type TabGatePasses<G extends string, Gates> = Record<G, (gates: Gates) => boolean>;

export function visibleTabs<G extends string, Gates>(
  tabs: readonly ServerTab<G>[],
  gates: Gates,
  passes: TabGatePasses<G, Gates>,
): ServerTab<G>[] {
  return tabs.filter((tab) => tab.gate === undefined || passes[tab.gate](gates));
}

export function tabHref(basePath: string, tab: ServerTab): string {
  return tab.segment === '' ? basePath : `${basePath}/${tab.segment}`;
}

export function activeTab<G extends string>(
  pathname: string,
  basePath: string,
  tabs: readonly ServerTab<G>[],
): ServerTab<G> | undefined {
  if (!pathname.startsWith(basePath)) return undefined;
  const rest = pathname.slice(basePath.length).replace(/^\/+|\/+$/g, '');
  const segment = rest.split('/')[0] ?? '';
  return tabs.find((tab) => tab.segment === segment);
}
