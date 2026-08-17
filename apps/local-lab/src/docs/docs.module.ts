import { Module, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Express } from 'express';

import { mountDocsAssets } from '../common/docs-assets';
import { ApiDocsController } from './api-docs.controller';
import { DocsController } from './docs.controller';
import { DocsService } from './docs.service';

@Module({
  controllers: [DocsController, ApiDocsController],
  providers: [DocsService],
})
export class DocsModule implements OnModuleInit {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  onModuleInit() {
    mountDocsAssets(this.httpAdapterHost.httpAdapter.getInstance<Express>());
  }
}
