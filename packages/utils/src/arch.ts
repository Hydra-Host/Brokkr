export function normalizeArchForArtifact(architecture: string | null | undefined): 'amd64' | 'arm64' {
  return architecture === 'aarch64' || architecture === 'arm64' ? 'arm64' : 'amd64';
}
