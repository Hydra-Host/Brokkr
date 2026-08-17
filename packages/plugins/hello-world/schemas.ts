import { z } from 'zod';

export const GreetingSchema = z
  .object({
    id: z.string().uuid().describe('Greeting row UUID.'),
    message: z.string().describe('Greeting text inserted by the plugin migration or runtime.'),
    createdAt: z.date().describe('Timestamp the greeting was recorded.'),
  })
  .describe('One row from plugin_hello_world.greetings.');

export const GreetingsListResponseSchema = z
  .array(GreetingSchema)
  .describe('All greetings owned by this plugin, oldest first.');

export type Greeting = z.infer<typeof GreetingSchema>;

export const HelloWorldConfigSchema = z
  .object({
    messagePrefix: z
      .string()
      .default('')
      .describe('Prepended to every greeting returned by the API. Defaults to empty.'),
  })
  .describe('hello-world plugin settings.');

export type HelloWorldConfig = z.infer<typeof HelloWorldConfigSchema>;
