import { IPXE_VALID_ARCHES, IPXE_VALID_EXTS, IPXE_VALID_TARGETS } from '../tftp/tftp-dyn-file.js';

export const DEFAULT_IPXE_TARGET = 'ipxe';
const DEFAULT_IPXE_EXT = 'efi';

const ARCH_AMD64 = 'amd64';
const ARCH_ARM64 = 'arm64';
const OPT93_ARCH_TO_DIR: ReadonlyMap<number, string> = new Map([
  [0x0000, ARCH_AMD64],
  [0x0002, ARCH_AMD64],
  [0x0006, ARCH_AMD64],
  [0x0007, ARCH_AMD64],
  [0x0008, ARCH_AMD64],
  [0x0009, ARCH_AMD64],
  [0x000a, ARCH_ARM64],
  [0x000b, ARCH_ARM64],
  [0x0011, ARCH_ARM64],
  [0x0013, ARCH_ARM64],
]);

const DEFAULT_ARCH_DIR = ARCH_AMD64;

export function resolveIpxeTarget(target: 'IPXE' | 'SNP' | 'SNPONLY' | null | undefined): string {
  if (target === null || target === undefined) return DEFAULT_IPXE_TARGET;
  const map: Record<string, string> = { IPXE: 'ipxe', SNP: 'snp', SNPONLY: 'snponly' };
  const resolved = map[target];
  if (resolved !== undefined && IPXE_VALID_TARGETS.has(resolved)) return resolved;
  return DEFAULT_IPXE_TARGET;
}

function bootfileForArchDir(archDir: string, target: string = DEFAULT_IPXE_TARGET): string {
  return `${target}-${archDir}.${DEFAULT_IPXE_EXT}`;
}

export function defaultBridgeBootfile(target?: string): string {
  return bootfileForArchDir(DEFAULT_ARCH_DIR, target ?? DEFAULT_IPXE_TARGET);
}

export function defaultBootfileByArch(target?: string): Map<number, string> {
  const resolvedTarget = target ?? DEFAULT_IPXE_TARGET;
  const out = new Map<number, string>();
  for (const [arch93, archDir] of OPT93_ARCH_TO_DIR) {
    out.set(arch93, bootfileForArchDir(archDir, resolvedTarget));
  }
  return out;
}

export function isServableBootfile(filename: string): boolean {
  const slash = filename.lastIndexOf('/');
  const base = slash === -1 ? filename : filename.slice(slash + 1);

  const dot = base.lastIndexOf('.');
  if (dot === -1) return false;
  const stem = base.slice(0, dot);
  const ext = base.slice(dot + 1);

  const segments = stem.split('-');
  if (segments.length < 2) return false;
  const [target, arch] = segments;

  return IPXE_VALID_TARGETS.has(target) && IPXE_VALID_ARCHES.has(arch) && IPXE_VALID_EXTS.has(ext);
}

export function assertServableBootfile(filename: string): string {
  if (!isServableBootfile(filename)) {
    throw new Error(
      `Derived DHCP bootfile ${JSON.stringify(filename)} is not servable by the TFTP server ` +
        `(expected {target}-{arch}.{ext} with target in {${[...IPXE_VALID_TARGETS].join(',')}}, ` +
        `arch in {${[...IPXE_VALID_ARCHES].join(',')}}, ext in {${[...IPXE_VALID_EXTS].join(',')}})`,
    );
  }
  return filename;
}
