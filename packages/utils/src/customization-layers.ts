export const LAYER_DISPLAY_ORDER: Record<string, number> = {
  tee: -1,
  gpuFramework: 0,
  gpuDriver: 1,
  mlFramework: 2,
  miscSoftware: 3,
};

export function compareCustomizationLayers(a: { slug: string }, b: { slug: string }): number {
  const ao = LAYER_DISPLAY_ORDER[a.slug] ?? 99;
  const bo = LAYER_DISPLAY_ORDER[b.slug] ?? 99;
  return ao - bo;
}

/** Reset payload must cover every catalog group slug: a bare `{}` leaves prior picks registered under `customizations.<groupSlug>` intact. */
export function emptyCustomizations(
  availableComponentLayersByBase: Record<string, ReadonlyArray<{ slug: string; selectionType: string }>>,
): Record<string, string | string[]> {
  const empty: Record<string, string | string[]> = {};
  for (const layers of Object.values(availableComponentLayersByBase)) {
    for (const group of layers) empty[group.slug] = group.selectionType === 'MULTI_SELECT' ? [] : '';
  }
  return empty;
}
