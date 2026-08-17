// @repo/local-lab-contract is CJS-classified (no "type": "module"); a dynamic import gets real
// named exports under Vitest but only a CJS-interop `default` under real Node/tsx — resolve both.
type LabContractModule = typeof import('@repo/local-lab-contract');

function hasDefaultExport<T extends object>(mod: T): mod is T & { default: T } {
  return 'default' in mod;
}

const resolved = await import('@repo/local-lab-contract');
const labContract: LabContractModule = hasDefaultExport(resolved) ? resolved.default : resolved;

export default labContract;
