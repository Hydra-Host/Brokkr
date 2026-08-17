import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { getErrorMessage } from '../common/error-utils';

import { ContextLogger } from '../logger/logger.service.js';

import { apiDoc } from './api-doc.js';
import { DocsService } from './docs.service.js';

const APP_CLASS_NAME = 'routes-docs';

function errorResponse(error: string): { error: string } {
  return { error };
}

apiDoc({ method: 'get', path: '/apispec.json', exclude: true });
apiDoc({ method: 'get', path: '/docs', exclude: true });
apiDoc({ method: 'get', path: '/docs/swagger', exclude: true });
apiDoc({ method: 'get', path: '/docs/redoc', exclude: true });

@Controller()
export class DocsController {
  constructor(
    private readonly docsService: DocsService,
    private readonly logger: ContextLogger,
  ) {}

  @Get('apispec.json')
  async getApispec(@Res() reply: FastifyReply): Promise<void> {
    try {
      const specDict = this.docsService.getSpecDict();
      await reply.status(200).send(specDict);
    } catch (e) {
      await this.logger.error(`Error retrieving API spec: ${getErrorMessage(e)}`, { appClassName: APP_CLASS_NAME });
      await reply.status(500).send(errorResponse('Failed to retrieve API specification'));
    }
  }

  @Get('docs')
  async docsRedirect(@Res() reply: FastifyReply): Promise<void> {
    try {
      const defaultFormat = this.docsService.getDefaultDocsFormat();

      if (defaultFormat === 'redoc' && this.docsService.isRedocEnabled()) {
        await reply.redirect('/docs/redoc');
      } else if (defaultFormat === 'swagger' && this.docsService.isSwaggerEnabled()) {
        await reply.redirect('/docs/swagger');
      } else if (this.docsService.isSwaggerEnabled()) {
        await reply.redirect('/docs/swagger');
      } else if (this.docsService.isRedocEnabled()) {
        await reply.redirect('/docs/redoc');
      } else {
        await reply.status(404).send(errorResponse('No documentation UI enabled'));
      }
    } catch (e) {
      await this.logger.error(`Error in docs redirect: ${getErrorMessage(e)}`, { appClassName: APP_CLASS_NAME });
      await reply.status(500).send(errorResponse('Documentation service error'));
    }
  }

  @Get('docs/swagger')
  async swaggerUi(@Res() reply: FastifyReply): Promise<void> {
    if (!this.docsService.isSwaggerEnabled()) {
      await reply.status(404).send(errorResponse('Swagger UI is disabled'));
      return;
    }
    try {
      const html = await this.docsService.renderSwaggerUi();
      await reply.status(200).header('content-type', 'text/html; charset=utf-8').send(html);
    } catch (e) {
      await this.logger.error(`Failed to render Swagger UI: ${getErrorMessage(e)}`, { appClassName: APP_CLASS_NAME });
      await reply.status(500).send(errorResponse(`Failed to render Swagger UI: ${getErrorMessage(e)}`));
    }
  }

  @Get('docs/redoc')
  async redoc(@Res() reply: FastifyReply): Promise<void> {
    if (!this.docsService.isRedocEnabled()) {
      await reply.status(404).send(errorResponse('ReDoc is disabled'));
      return;
    }
    try {
      const html = await this.docsService.renderRedoc();
      await reply.status(200).header('content-type', 'text/html; charset=utf-8').send(html);
    } catch (e) {
      await this.logger.error(`Failed to render ReDoc: ${getErrorMessage(e)}`, { appClassName: APP_CLASS_NAME });
      await reply.status(500).send(errorResponse(`Failed to render ReDoc: ${getErrorMessage(e)}`));
    }
  }
}
