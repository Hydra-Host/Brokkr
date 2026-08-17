import { z } from 'zod';

export const initrdDownloadParamsSchema = z
  .object({
    build: z.string().nullish(),
  })
  .strip();

export type InitrdDownloadParams = z.infer<typeof initrdDownloadParamsSchema>;
