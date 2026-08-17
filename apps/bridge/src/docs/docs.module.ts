import { Module, type OnModuleInit } from '@nestjs/common';

import { DocsController } from './docs.controller.js';
import { DocsService } from './docs.service.js';

@Module({
  controllers: [DocsController],
  providers: [DocsService],
  exports: [DocsService],
})
export class DocsModule implements OnModuleInit {
  constructor(private readonly docsService: DocsService) {}

  async onModuleInit(): Promise<void> {
    await this.docsService.initializeSpec();
  }
}
