import { z } from 'zod';

export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, '64-char lowercase hex')
  .describe('Lowercase hex-encoded SHA-256 digest (64 characters).');

export const upgrade = {
  input: z.object({
    sha256: Sha256Hex.describe('Expected SHA-256 of the bundle; agent passes this to FetchBundle(artifact=BUNDLE).'),
    expected_version: z
      .string()
      .describe(
        'Semver (or commit-SHA) version the bundle should report after restart; used for post-upgrade verification.',
      ),
    unit_sha256: Sha256Hex.optional().describe(
      'Optional expected SHA-256 of a systemd unit file to swap alongside the bundle. When present the agent issues a second FetchBundle(artifact=UNIT). Absent means "keep the existing unit file".',
    ),
    config_sha256: Sha256Hex.optional().describe(
      'Optional expected SHA-256 of a freshly-rendered agent.yaml the bridge has cached for this upgrade. When present the agent issues a third FetchBundle(artifact=CONFIG) and atomically swaps /opt/brokkr/agent.yaml. Absent means "keep the existing agent.yaml".',
    ),
  }),
  output: z.object({
    bundle_bytes: z
      .number()
      .int()
      .positive()
      .describe('Byte length of the downloaded bundle after SHA-256 verification.'),
    sha256_verified: z.literal(true).describe('Present and true exactly when the bundle hash matched input.sha256.'),
    unit_replaced: z.boolean().describe('True when unit_sha256 was provided and the unit file was swapped.'),
    config_replaced: z.boolean().describe('True when config_sha256 was provided and agent.yaml was swapped.'),
    restart_scheduled_at_ms: z
      .number()
      .int()
      .describe(
        'Wall-clock unix-ms timestamp at which the handler scheduled the exit. Present on success; the agent exits shortly after.',
      ),
  }),
} as const;

export const operations = { upgrade } as const;
