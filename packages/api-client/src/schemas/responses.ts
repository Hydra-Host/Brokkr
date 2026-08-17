import { z } from 'zod';

export const HelloResponseSchema = z.object({
  message: z.string().describe('Hello greeting message'),
});

export type HelloResponse = z.infer<typeof HelloResponseSchema>;

export const ErrorResponseSchema = z.object({
  statusCode: z.number().describe('HTTP status code of the error'),
  message: z.string().describe('Human-readable error message'),
  error: z.string().optional().describe('Error type or classification'),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
