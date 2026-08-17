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
