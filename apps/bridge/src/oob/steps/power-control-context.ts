import { z } from 'zod';

import { bmcCredentials, type BmcCredentials } from '../../common/bmc.types';
import type { SagaContext } from '../../saga-framework/saga.types';
import { forwardedSecretSchema, openBmcSecret } from '../../zone-crypto/device-secret-open';

export { skipIfBrokkrLiveReady, type SkipResult } from '../../saga-framework/brokkr-live-skip';

const credSagaPayloadSchema = z.object({
  bmc_ip: z.string().min(1),
  secrets: z.object({ bmc: forwardedSecretSchema }),
});

export interface PowerControlPayload {
  bmc_ip: string;
  secrets: { bmc: z.infer<typeof forwardedSecretSchema> };
}

/** Opens the inner sealed layer (`secrets.bmc`); throws on any malformed/unopenable credential so it never reaches hardware. */
export function credsFromContext(ctx: SagaContext): BmcCredentials {
  const parsed = credSagaPayloadSchema.safeParse(ctx.payload);
  if (!parsed.success) {
    throw new TypeError(`Missing or invalid BMC credential payload: ${parsed.error.message}`);
  }
  const { username, password } = openBmcSecret(parsed.data.secrets.bmc);
  return bmcCredentials(parsed.data.bmc_ip, username, password);
}
