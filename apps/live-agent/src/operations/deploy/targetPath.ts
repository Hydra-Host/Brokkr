import { resolve, sep } from 'node:path';

const BASE_ROOTS: readonly string[] = ['/target', '/mnt'];

let extraRoots: string[] = [];

function allowedRoots(): string[] {
  return [...BASE_ROOTS, ...extraRoots];
}

export function _addAllowedRootForTesting(root: string): void {
  const normalized = resolve(root);
  if (!BASE_ROOTS.includes(normalized) && !extraRoots.includes(normalized)) {
    extraRoots.push(normalized);
  }
}

export function _resetAllowedRootsForTesting(): void {
  extraRoots = [];
}

export function assertTargetPathSafe(targetPath: string): string {
  const normalized = resolve(targetPath);
  const roots = allowedRoots();
  const allowed = roots.some((root) => normalized === root || normalized.startsWith(`${root}${sep}`));
  if (!allowed) {
    throw new Error(`rejected target_path outside ${roots.join(' or ')}: ${normalized}`);
  }
  return normalized;
}
