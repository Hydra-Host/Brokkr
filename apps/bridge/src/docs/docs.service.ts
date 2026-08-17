import { existsSync } from 'node:fs';

import { Injectable } from '@nestjs/common';
import * as nunjucks from 'nunjucks';

import { NIL_JOB_ID } from '../constants.js';
import { ContextLogger } from '../logger/logger.service.js';

import { buildOpenApiSpec, type OpenApiSpec, type OpenApiSpecOptions } from './api-doc.js';
import { getDocsConfig } from './docs.config.js';

const APP_CLASS_NAME = 'service-docs';
const DEFAULT_BRIDGE_HOST = '0.0.0.0';

export class DocsServiceError extends Error {}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileNotFoundError';
  }
}

export type OpenApiSpecGenerator = (options: OpenApiSpecOptions) => OpenApiSpec | Promise<OpenApiSpec>;

function countKeys(value: unknown): number {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.keys(value).length;
  }
  return 0;
}

function jsonDumpsSpaced(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(jsonDumpsSpaced).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ': ' + jsonDumpsSpaced(v)).join(', ') + '}';
  }
  return JSON.stringify(value);
}

function resolveAppVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRIDGE_API_VERSION && env.BRIDGE_API_VERSION.length > 0 ? env.BRIDGE_API_VERSION : '0.0.0-dev';
}

function resolveAppHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOST && env.HOST.length > 0 ? env.HOST : DEFAULT_BRIDGE_HOST;
}

@Injectable()
export class DocsService {
  private specDict: OpenApiSpec | null = null;
  private nunjucksEnv: nunjucks.Environment | null = null;

  constructor(private readonly logger: ContextLogger) {}

  private getNunjucksEnv(): nunjucks.Environment {
    if (this.nunjucksEnv === null) {
      const templateDir = getDocsConfig().docsAssetsPath;
      if (!existsSync(templateDir)) {
        throw new FileNotFoundError(`Templates directory not found: ${templateDir}`);
      }
      this.nunjucksEnv = new nunjucks.Environment(new nunjucks.FileSystemLoader(templateDir), { autoescape: true });
    }
    return this.nunjucksEnv;
  }

  private convertTemplateNotFound(exc: unknown, templateName: string): FileNotFoundError | null {
    const message = exc instanceof Error ? exc.message : String(exc);
    if (/template not found/i.test(message)) {
      return new FileNotFoundError(`${templateName} template not found`);
    }
    return null;
  }

  async initializeSpec(generate: OpenApiSpecGenerator = buildOpenApiSpec): Promise<OpenApiSpec> {
    const docsConfig = getDocsConfig();
    const version = resolveAppVersion();
    const host = resolveAppHost();
    await this.logger.debug(`Generating OpenAPI spec: ${docsConfig.apiTitle} v${version}`, {
      appClassName: APP_CLASS_NAME,
      jobId: NIL_JOB_ID,
    });

    const securitySchemes = Object.keys(docsConfig.securitySchemes).length > 0 ? docsConfig.securitySchemes : null;

    this.specDict = await generate({
      title: docsConfig.apiTitle,
      version,
      info: docsConfig.openapiInfo,
      servers: [
        {
          url: `https://${host}`,
          description: docsConfig.apiServerDescription,
        },
      ],
      securitySchemes,
      security: null,
    });

    const pathCount = countKeys(this.specDict['paths']);
    const components = this.specDict['components'];
    const schemaCount = countKeys(
      typeof components === 'object' && components !== null ? (components as Record<string, unknown>)['schemas'] : null,
    );
    await this.logger.info(`OpenAPI spec: ${pathCount} paths, ${schemaCount} schemas`, {
      appClassName: APP_CLASS_NAME,
      jobId: NIL_JOB_ID,
    });

    return this.specDict;
  }

  getSpecDict(): OpenApiSpec {
    if (!this.specDict || Object.keys(this.specDict).length === 0) {
      throw new DocsServiceError('OpenAPI spec not initialized. Call initializeSpec() first.');
    }
    return this.specDict;
  }

  isSwaggerEnabled(): boolean {
    return getDocsConfig().enableSwaggerUi;
  }

  isRedocEnabled(): boolean {
    return getDocsConfig().enableRedoc;
  }

  getDefaultDocsFormat(): string {
    return getDocsConfig().defaultDocsFormat;
  }

  async renderSwaggerUi(): Promise<string> {
    const docsConfig = getDocsConfig();
    try {
      return this.getNunjucksEnv().render('swagger.html.njk', {
        api_title: docsConfig.apiTitle,
        swagger_version: docsConfig.swaggerUiVersion,
        swagger_config_json: jsonDumpsSpaced(docsConfig.swaggerUiConfig),
      });
    } catch (exc) {
      const converted = this.convertTemplateNotFound(exc, 'swagger.html.njk');
      if (converted !== null) throw converted;
      await this.logger.warning(
        `Error rendering Swagger UI template: ${exc instanceof Error ? exc.message : String(exc)}`,
        {
          appClassName: APP_CLASS_NAME,
        },
      );
      throw exc;
    }
  }

  async renderRedoc(): Promise<string> {
    const docsConfig = getDocsConfig();
    try {
      return this.getNunjucksEnv().render('redoc.html.njk', {
        api_title: docsConfig.apiTitle,
        redoc_version: docsConfig.redocVersion,
        redoc_options_json: jsonDumpsSpaced(docsConfig.redocOptions),
        redoc_theme_json: jsonDumpsSpaced(docsConfig.redocTheme),
      });
    } catch (exc) {
      const converted = this.convertTemplateNotFound(exc, 'redoc.html.njk');
      if (converted !== null) throw converted;
      await this.logger.warning(`Error rendering ReDoc template: ${exc instanceof Error ? exc.message : String(exc)}`, {
        appClassName: APP_CLASS_NAME,
      });
      throw exc;
    }
  }
}
