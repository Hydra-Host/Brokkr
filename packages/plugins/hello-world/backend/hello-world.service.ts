import { getPluginConfigToken, PLUGIN_PRISMA_CLIENT, PluginDb } from '@hydrahost/plugin-sdk';
import { Inject, Injectable } from '@nestjs/common';

import { Greeting, GreetingsListResponseSchema, HelloWorldConfig } from '../schemas';

const HELLO_WORLD_CONFIG_TOKEN = getPluginConfigToken('hello-world');

@Injectable()
export class HelloWorldService {
  constructor(
    @Inject(PLUGIN_PRISMA_CLIENT) private readonly db: PluginDb,
    @Inject(HELLO_WORLD_CONFIG_TOKEN) private readonly config: HelloWorldConfig,
  ) {}

  async listGreetings(): Promise<Greeting[]> {
    const rows = await this.db.$queryRawUnsafe<unknown>(
      'SELECT id, message, created_at AS "createdAt" FROM plugin_hello_world.greetings ORDER BY created_at ASC',
    );
    const greetings = GreetingsListResponseSchema.parse(rows);
    return greetings.map((g) => ({ ...g, message: `${this.config.messagePrefix}${g.message}` }));
  }
}
