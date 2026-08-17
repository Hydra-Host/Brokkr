import { z } from 'zod';

export const grubDownloadParamsSchema = z.object({
  arch: z.string().default('amd64'),
  platform: z.string().default('efi'),
});

export type GrubDownloadParams = z.infer<typeof grubDownloadParamsSchema>;

export const discoveryDownloadParamsSchema = z.object({
  arch: z.string(),
  filename: z.string(),
});

export type DiscoveryDownloadParams = z.infer<typeof discoveryDownloadParamsSchema>;

export const fileDownloadResponseSchema = z.object({
  content_type: z.string().default('application/octet-stream'),
  content_length: z.number().int(),
  content_disposition: z.string(),
  accept_ranges: z.string().default('bytes'),
});

export type FileDownloadResponse = z.infer<typeof fileDownloadResponseSchema>;
