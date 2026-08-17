import { PLUGIN_EMAIL } from '@hydrahost/plugin-sdk';
import { Global, Module } from '@nestjs/common';

import { EmailModule } from './email.module';
import { HostPluginEmail } from './host-plugin-email';

@Global()
@Module({
  imports: [EmailModule],
  providers: [HostPluginEmail, { provide: PLUGIN_EMAIL, useExisting: HostPluginEmail }],
  exports: [PLUGIN_EMAIL],
})
export class PluginEmailModule {}
