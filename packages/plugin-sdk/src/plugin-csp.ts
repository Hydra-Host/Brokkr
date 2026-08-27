export const PLUGIN_CSP_DIRECTIVES = [
  'scriptSrc',
  'workerSrc',
  'imgSrc',
  'connectSrc',
  'styleSrc',
  'fontSrc',
  'frameSrc',
] as const;

export type PluginCspDirective = (typeof PLUGIN_CSP_DIRECTIVES)[number];

/** Extra CSP source tokens the host merges into the global policy when this plugin is enabled. */
export type PluginCspContribution = {
  [K in PluginCspDirective]?: readonly string[];
};

export type MergedPluginCsp = {
  [K in PluginCspDirective]: string[];
};

function emptyMergedCsp(): MergedPluginCsp {
  return {
    scriptSrc: [],
    workerSrc: [],
    imgSrc: [],
    connectSrc: [],
    styleSrc: [],
    fontSrc: [],
    frameSrc: [],
  };
}

export function mergePluginCsp(contributions: readonly (PluginCspContribution | undefined)[]): MergedPluginCsp {
  const merged = emptyMergedCsp();
  const seen: { [K in PluginCspDirective]: Set<string> } = {
    scriptSrc: new Set(),
    workerSrc: new Set(),
    imgSrc: new Set(),
    connectSrc: new Set(),
    styleSrc: new Set(),
    fontSrc: new Set(),
    frameSrc: new Set(),
  };

  for (const contribution of contributions) {
    if (!contribution) continue;
    for (const directive of PLUGIN_CSP_DIRECTIVES) {
      const sources = contribution[directive];
      if (!sources) continue;
      for (const source of sources) {
        if (seen[directive].has(source)) continue;
        seen[directive].add(source);
        merged[directive].push(source);
      }
    }
  }

  return merged;
}

export function formatCspSources(sources: readonly string[]): string {
  if (sources.length === 0) return '';
  return ` ${sources.join(' ')}`;
}
