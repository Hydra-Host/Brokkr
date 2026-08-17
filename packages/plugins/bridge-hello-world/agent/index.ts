import { defineAgentPlugin } from '@hydrahost/plugin-sdk';
import { z } from 'zod';

const PingInputSchema = z.object({ message: z.string() });

const PingOutputSchema = z.object({ echo: z.string(), respondedAt: z.string() });

export default defineAgentPlugin({
  id: 'bridge-hello-world',
  setup({ registerOperation }) {
    registerOperation('ping', PingInputSchema, PingOutputSchema, (input) => ({
      echo: input.message,
      respondedAt: new Date().toISOString(),
    }));
  },
});
