// More-specific tokens (gb300, gh200) must be checked before their shorter supersets (b300, h200) — order is load-bearing.
export function parseGpuFamily(gpuModel: string | null | undefined): string | null {
  if (!gpuModel) return null;
  const lower = gpuModel.toLowerCase();
  switch (true) {
    case lower.includes('gb300'):
    case lower.includes('b300'):
      return 'b300';
    case lower.includes('gb200'):
    case lower.includes('b200'):
      return 'b200';
    case lower.includes('gh200'):
    case lower.includes('h200'):
      return 'h200';
    case lower.includes('h100'):
      return 'h100';
    default:
      return null;
  }
}
