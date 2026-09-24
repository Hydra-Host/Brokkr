import { PLUGIN_ENABLED_IDS, type PluginEnabledIds } from '@hydrahost/plugin-sdk';
import { Controller, Inject } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { Public } from '../auth/decorators/public.decorator';
import { ContextService } from '../common/context/context.service';

@Controller()
export class PluginsMetaController {
  constructor(
    private readonly contextService: ContextService,
    @Inject(PLUGIN_ENABLED_IDS) private readonly enabledPluginIds: PluginEnabledIds,
  ) {}

  @Public()
  @TsRestHandler(contract.getEnabledPlugins)
  async getEnabledPlugins() {
    return tsRestHandler(contract.getEnabledPlugins, async () => ({
      status: 200,
      body: { pluginIds: [...this.enabledPluginIds] },
    }));
  }

  // Authenticated (not @Public): the guard must populate identity for operator gating.
  @TsRestHandler(contract.getPluginHostContext)
  async getPluginHostContext() {
    return tsRestHandler(contract.getPluginHostContext, async () => ({
      status: 200,
      body: { isInstanceOperator: this.contextService.isInstanceOperator },
    }));
  }
}
