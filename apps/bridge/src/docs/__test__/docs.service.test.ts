import { existsSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenApiSpec } from '../api-doc.js';
import { DocsService, DocsServiceError, FileNotFoundError } from '../docs.service.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const docsConfigStub = {
  apiTitle: 'Test API',
  apiServerDescription: 'Test API Server',
  docsAssetsPath: '/test/docs/assets',
  enableSwaggerUi: true,
  enableRedoc: true,
  defaultDocsFormat: 'swagger',
  swaggerUiVersion: '5.18.2',
  redocVersion: '2.5.2',
  openapiInfo: { description: 'Test API Documentation' },
  securitySchemes: {} as Record<string, unknown>,
  swaggerUiConfig: { deepLinking: true } as Record<string, unknown>,
  redocOptions: { expandResponses: '200,201' } as Record<string, unknown>,
  redocTheme: { colors: { primary: { main: '#ffdc75' } } } as Record<string, unknown>,
};

vi.mock('../docs.config.js', () => ({
  getDocsConfig: () => docsConfigStub,
}));

function loggerStub() {
  return {
    debug: vi.fn(async () => {}),
    info: vi.fn(async () => {}),
    warning: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
  };
}

function buildService(): DocsService {
  return new DocsService(loggerStub() as never);
}

describe('DocsService', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
    docsConfigStub.enableSwaggerUi = true;
    docsConfigStub.enableRedoc = true;
    docsConfigStub.defaultDocsFormat = 'swagger';
  });

  it('initializes with null spec and null nunjucks env', () => {
    const service = buildService();
    expect((service as unknown as { specDict: unknown }).specDict).toBeNull();
    expect((service as unknown as { nunjucksEnv: unknown }).nunjucksEnv).toBeNull();
  });

  it('lazily creates the nunjucks environment', () => {
    const service = buildService();
    const env = (service as unknown as { getNunjucksEnv: () => unknown }).getNunjucksEnv();
    expect(env).not.toBeNull();
    expect((service as unknown as { nunjucksEnv: unknown }).nunjucksEnv).toBe(env);
  });

  it('caches the nunjucks environment across calls', () => {
    const service = buildService();
    const getter = (service as unknown as { getNunjucksEnv: () => unknown }).getNunjucksEnv.bind(service);
    const env1 = getter();
    const env2 = getter();
    expect(env1).toBe(env2);
  });

  it('throws FileNotFoundError when the templates directory is missing', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const service = buildService();
    expect(() => (service as unknown as { getNunjucksEnv: () => unknown }).getNunjucksEnv()).toThrowError(
      FileNotFoundError,
    );
    expect(() => (service as unknown as { getNunjucksEnv: () => unknown }).getNunjucksEnv()).toThrowError(
      /Templates directory not found/,
    );
  });

  it('initializeSpec stores the generated spec and returns it', async () => {
    const spec: OpenApiSpec = { openapi: '3.0.2', paths: { '/a': {} }, components: { schemas: { X: {} } } };
    const service = buildService();
    const result = await service.initializeSpec(() => spec);
    expect(result).toEqual(spec);
    expect((service as unknown as { specDict: OpenApiSpec }).specDict).toEqual(spec);
  });

  it('getSpecDict returns the cached spec', () => {
    const service = buildService();
    const spec: OpenApiSpec = { openapi: '3.0.2', info: { title: 'Test API' } };
    (service as unknown as { specDict: OpenApiSpec }).specDict = spec;
    expect(service.getSpecDict()).toEqual(spec);
  });

  it('getSpecDict throws DocsServiceError when not initialized', () => {
    const service = buildService();
    expect(() => service.getSpecDict()).toThrowError(DocsServiceError);
    expect(() => service.getSpecDict()).toThrowError(/OpenAPI spec not initialized/);
  });

  it('exposes configuration via getters', () => {
    const service = buildService();
    expect(service.isSwaggerEnabled()).toBe(true);
    expect(service.isRedocEnabled()).toBe(true);
    expect(service.getDefaultDocsFormat()).toBe('swagger');
  });
});

describe('DocsService template rendering', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it('renderSwaggerUi renders the swagger.html.njk template with the expected context', async () => {
    const service = buildService();
    const renderSpy = vi.fn(() => '<html>Swagger UI</html>');
    (service as unknown as { nunjucksEnv: { render: typeof renderSpy } }).nunjucksEnv = { render: renderSpy };

    const result = await service.renderSwaggerUi();

    expect(result).toBe('<html>Swagger UI</html>');
    expect(renderSpy).toHaveBeenCalledTimes(1);
    const call = renderSpy.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[0]).toBe('swagger.html.njk');
    expect(call[1]['api_title']).toBe('Test API');
    expect(call[1]['swagger_version']).toBe('5.18.2');
  });

  it('renderSwaggerUi converts template-not-found errors to FileNotFoundError', async () => {
    const service = buildService();
    (service as unknown as { nunjucksEnv: { render: () => string } }).nunjucksEnv = {
      render: () => {
        throw new Error('template not found: swagger.html.njk');
      },
    };

    await expect(service.renderSwaggerUi()).rejects.toThrowError(FileNotFoundError);
    await expect(service.renderSwaggerUi()).rejects.toThrowError(/swagger\.html\.njk template not found/);
  });

  it('renderRedoc renders the redoc.html.njk template with the expected context', async () => {
    const service = buildService();
    const renderSpy = vi.fn(() => '<html>ReDoc</html>');
    (service as unknown as { nunjucksEnv: { render: typeof renderSpy } }).nunjucksEnv = { render: renderSpy };

    const result = await service.renderRedoc();

    expect(result).toBe('<html>ReDoc</html>');
    expect(renderSpy).toHaveBeenCalledTimes(1);
    const call = renderSpy.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[0]).toBe('redoc.html.njk');
    expect(call[1]['api_title']).toBe('Test API');
    expect(call[1]['redoc_version']).toBe('2.5.2');
  });

  it('renderRedoc converts template-not-found errors to FileNotFoundError', async () => {
    const service = buildService();
    (service as unknown as { nunjucksEnv: { render: () => string } }).nunjucksEnv = {
      render: () => {
        throw new Error('template not found: redoc.html.njk');
      },
    };

    await expect(service.renderRedoc()).rejects.toThrowError(FileNotFoundError);
    await expect(service.renderRedoc()).rejects.toThrowError(/redoc\.html\.njk template not found/);
  });
});
