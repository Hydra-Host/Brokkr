// @repo/utils ships untranspiled TS source with no "type": "module" — same Node/Vitest module
// shape mismatch as ./lab-contract.ts; see that file for the full explanation.
type LabUtilsModule = typeof import('@repo/utils');

function hasDefaultExport<T extends object>(mod: T): mod is T & { default: T } {
  return 'default' in mod;
}

const resolved = await import('@repo/utils');
const labUtils: LabUtilsModule = hasDefaultExport(resolved) ? resolved.default : resolved;

export default labUtils;
