import { Module, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Express } from 'express';

import { mountDocsAssets } from '../common/docs-assets';
import { ApiDocsController } from './api-docs.controller';

@Module({
  controllers: [ApiDocsController],
})
export class DocsModule implements OnModuleInit {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  onModuleInit() {
    mountDocsAssets(this.httpAdapterHost.httpAdapter.getInstance<Express>());
  }
}
