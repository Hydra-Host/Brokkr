import type { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { PrismaClient } from 'src/prisma/prisma.client';
import { BRAND_NAME } from './branding';
import { getRedocHtml, swaggerCss } from './docs-html';
import { generateApiDocument } from './openapi';

export async function registerApiDocs(app: INestApplication): Promise<void> {
  const prisma = app.get(PrismaClient);
  const v1Doc = await generateApiDocument(prisma, ['public']);

  SwaggerModule.setup('api/v1/swagger', app, () => v1Doc, {
    customCss: swaggerCss,
    customSiteTitle: `${BRAND_NAME} API v1`,
    swaggerOptions: {
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      persistAuthorization: true,
    },
  });

  SwaggerModule.setup('api/swagger', app, () => v1Doc, {
    customCss: swaggerCss,
    customSiteTitle: `${BRAND_NAME} API Documentation`,
    swaggerOptions: {
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      persistAuthorization: true,
    },
  });

  const httpAdapter = app.getHttpAdapter();
  const send = (res: { type: (t: string) => void; send: (b: string) => void }, body: string) => {
    res.type('text/html');
    res.send(body);
  };

  httpAdapter.get('/api/v1/redoc', (_req: unknown, res) => send(res, getRedocHtml('/api/v1/swagger-json')));
  httpAdapter.get('/api/redoc', (_req: unknown, res) => send(res, getRedocHtml('/api/v1/swagger-json')));
}
