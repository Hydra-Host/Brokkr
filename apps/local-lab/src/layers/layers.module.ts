import { Module } from '@nestjs/common';

import { RunnerModule } from '../runner/runner.module';
import { ServicesModule } from '../services/services.module';
import { LayerCacheService } from './layer-cache.service';
import { LayersController } from './layers.controller';
import { LayersService } from './layers.service';

@Module({
  imports: [RunnerModule, ServicesModule],
  controllers: [LayersController],
  providers: [LayersService, LayerCacheService],
  exports: [LayerCacheService],
})
export class LayersModule {}
