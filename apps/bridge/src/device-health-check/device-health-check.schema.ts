import { z } from 'zod';

import { bmcSecretDispatchFields } from '../common/bmc-secret.schema';

export const deviceHealthCheckSagaPayloadSchema = z
  .object({
    ...bmcSecretDispatchFields,
    primary_ip: z.string().nullish(),
  })
  .strict();

export type DeviceHealthCheckSagaPayload = z.infer<typeof deviceHealthCheckSagaPayloadSchema>;
