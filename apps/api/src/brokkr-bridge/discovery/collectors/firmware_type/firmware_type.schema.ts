import { z } from 'zod';

export const firmwareTypeSchema = z.string().trim();

export type FirmwareTypeInput = z.infer<typeof firmwareTypeSchema>;
