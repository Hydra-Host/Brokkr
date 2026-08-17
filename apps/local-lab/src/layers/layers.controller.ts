import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { LabRoute } from '../common/lab-route';
import { contract } from '../contract';
import { LayerCacheService } from './layer-cache.service';
import { LayersService } from './layers.service';

@Controller()
export class LayersController {
  constructor(
    private readonly layers: LayersService,
    private readonly cache: LayerCacheService,
  ) {}

  @TsRestHandler(contract.getLayersManifest)
  manifest() {
    return tsRestHandler(contract.getLayersManifest, async ({ query }) => ({
      status: 200 as const,
      body: await this.layers.fetchManifest(query.url),
    }));
  }

  @TsRestHandler(contract.getLayersDefaultUrl)
  layersDefaultUrl() {
    return tsRestHandler(contract.getLayersDefaultUrl, async () => ({
      status: 200 as const,
      body: { url: this.layers.layersDefaultUrl() },
    }));
  }

  @TsRestHandler(contract.seedManifest)
  seed() {
    return tsRestHandler(contract.seedManifest, async ({ body }) => ({
      status: 200 as const,
      body: { runId: this.layers.seedManifest(body.url) },
    }));
  }

  @TsRestHandler(contract.getLayerCache)
  layerCache() {
    return tsRestHandler(contract.getLayerCache, async () => ({
      status: 200 as const,
      body: { shas: await this.cache.cachedBlobShas() },
    }));
  }

  @TsRestHandler(contract.primeBlob)
  @LabRoute({ exposure: 'loopback-only' })
  prime() {
    return tsRestHandler(contract.primeBlob, async ({ body }) => ({
      status: 200 as const,
      body: { runId: this.cache.primeBlob(body.sha) },
    }));
  }

  @TsRestHandler(contract.nukeBlob)
  @LabRoute({ exposure: 'loopback-only' })
  nuke() {
    return tsRestHandler(contract.nukeBlob, async ({ body }) => ({
      status: 200 as const,
      body: { ok: await this.cache.nukeBlob(body.sha) },
    }));
  }
}
