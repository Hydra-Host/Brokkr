export interface DeploymentConfig {
  defaultDistro: string;
  defaultVariant: string;
  defaultBootDevice: string;
}

let cachedDeployment: DeploymentConfig | null = null;

export function getDeploymentConfig(): DeploymentConfig {
  if (cachedDeployment === null) {
    cachedDeployment = { defaultDistro: 'ubuntu', defaultVariant: 'server', defaultBootDevice: 'pxe' };
  }
  return cachedDeployment;
}

export function resetDeploymentConfigForTests(): void {
  cachedDeployment = null;
}

const DOCA_VERSION = '3.3.0';

const DOCA_SUPPORTED_REPOS: ReadonlySet<string> = new Set([
  'ubuntu22.04|x86_64',
  'ubuntu22.04|aarch64',
  'ubuntu22.04|arm64-sbsa',
  'ubuntu24.04|x86_64',
  'ubuntu24.04|aarch64',
  'ubuntu24.04|arm64-sbsa',
  'ubuntu25.10|x86_64',
  'ubuntu25.10|arm64-sbsa',
]);

const CURTIN_ARCH_TO_DOCA_REPO_ARCH: Readonly<Record<string, string>> = {
  amd64: 'x86_64',
  arm64: 'arm64-sbsa',
};

function sortedReposRepr(): string {
  const tuples = Array.from(DOCA_SUPPORTED_REPOS).map((key) => {
    const [codename, arch] = key.split('|');
    return [codename, arch] as const;
  });
  tuples.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  return `[${tuples.map(([codename, arch]) => `('${codename}', '${arch}')`).join(', ')}]`;
}

export function getDocaRepoUrl(osCodename: string, curtinArch: string): string {
  const repoArch = CURTIN_ARCH_TO_DOCA_REPO_ARCH[curtinArch];
  if (repoArch === undefined) {
    throw new Error(`No DOCA repo arch mapping for curtin arch '${curtinArch}'`);
  }
  if (!DOCA_SUPPORTED_REPOS.has(`${osCodename}|${repoArch}`)) {
    throw new Error(
      `DOCA ${DOCA_VERSION} has no published repo for ${osCodename}/${repoArch}; ` + `supported: ${sortedReposRepr()}`,
    );
  }
  return `https://linux.mellanox.com/public/repo/doca/${DOCA_VERSION}/${osCodename}/${repoArch}/`;
}
