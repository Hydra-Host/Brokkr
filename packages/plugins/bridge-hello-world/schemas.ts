import { z } from 'zod';

export const BridgeHelloWorldConfigSchema = z.object({
  greeting: z.string().default('hello from the bridge plugin host'),
});

export type BridgeHelloWorldConfig = z.infer<typeof BridgeHelloWorldConfigSchema>;
