export interface UpgradePayloadInput {
  sha: string;
  expectedVersion: string;
  unitSha?: string | null;
  configSha?: string | null;
}

export interface UpgradePayload {
  sha256: string;
  expected_version: string;
  unit_sha256?: string;
  config_sha256?: string;
}

export function buildUpgradePayload(args: UpgradePayloadInput): UpgradePayload {
  const payload: UpgradePayload = {
    sha256: args.sha,
    expected_version: args.expectedVersion,
  };
  if (args.unitSha) {
    payload.unit_sha256 = args.unitSha;
  }
  if (args.configSha) {
    payload.config_sha256 = args.configSha;
  }
  return payload;
}
