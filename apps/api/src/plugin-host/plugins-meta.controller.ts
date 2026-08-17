import pluginsConfig from '@hydrahost/plugins-config';
import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { Public } from '../auth/decorators/public.decorator';
import { ContextService } from '../common/context/context.service';

const enabledPluginIds: string[] = pluginsConfig.filter((entry) => entry.enabled).map((entry) => entry.plugin.id);

@Controller()
export class PluginsMetaController {
  constructor(private readonly contextService: ContextService) {}

  @Public()
  @TsRestHandler(contract.getEnabledPlugins)
  async getEnabledPlugins() {
    return tsRestHandler(contract.getEnabledPlugins, async () => ({
      status: 200,
      body: { pluginIds: enabledPluginIds },
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
