import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { NamedZodSchema, OpenApiSpecOptions } from '../api-doc.js';
import {
  apiDoc,
  buildOpenApiSpec,
  buildQueryParams,
  cleanSchema,
  collectComponentSchemas,
  registeredApiDocs,
  resetApiDocs,
  schemaRef,
} from '../api-doc.js';

const options: OpenApiSpecOptions = {
  title: 'Test API',
  version: '1.2.3',
  info: { description: 'desc' },
  servers: [{ url: 'https://bridge.example.com', description: 'Bridge Server' }],
  securitySchemes: null,
  security: null,
};

const SimpleModel: NamedZodSchema = {
  name: 'SimpleModel',
  schema: z.object({ name: z.string(), age: z.number().int() }),
};

const ErrorResponse: NamedZodSchema = {
  name: 'ErrorResponse',
  description: 'Standard error response.',
  schema: z.object({ error: z.string(), code: z.number().int() }),
};

const QueryParams: NamedZodSchema = {
  name: 'QueryParams',
  schema: z.object({
    limit: z.number().int().min(1).describe('Max results').default(10),
    cursor: z.string().optional(),
  }),
};

describe('api-doc registry', () => {
  afterEach(() => {
    resetApiDocs();
  });

  it('registers entries once per method+path', () => {
    apiDoc({ method: 'get', path: '/api/grub', summary: 'Download GRUB bootloader' });
    apiDoc({ method: 'get', path: '/api/grub', summary: 'duplicate' });
    expect(registeredApiDocs()).toHaveLength(1);
    expect(registeredApiDocs()[0]?.summary).toBe('Download GRUB bootloader');
  });

  it('builds a sorted spec with derived tags, params, and responses', () => {
    apiDoc({
      method: 'post',
      path: '/api/chain',
      summary: 'Generate iPXE chain script',
      contentType: 'text/plain',
      responses: { 200: 'IpxeScriptResponse', 400: 'IpxeTextErrorResponse' },
    });
    apiDoc({ method: 'get', path: '/api/initrd/<string:build_name>', summary: 'Download initrd by build name' });

    const spec = buildOpenApiSpec(options);
    expect(spec['openapi']).toBe('3.0.2');
    expect(spec['info']).toEqual({ title: 'Test API', version: '1.2.3', description: 'desc' });
    expect(spec['servers']).toEqual([{ url: 'https://bridge.example.com', description: 'Bridge Server' }]);

    const paths = spec['paths'];
    expect(paths).toBeTypeOf('object');
    expect(Object.keys(paths ?? {})).toEqual(['/api/chain', '/api/initrd/{build_name}']);

    const pathsObj = (paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
    const chainOp = pathsObj['/api/chain']!['post']!;
    expect(chainOp['tags']).toEqual(['iPXE Network Boot']);
    expect((chainOp['responses'] as Record<string, unknown>)['200']).toEqual({
      description: 'IpxeScriptResponse',
      content: { 'text/plain': {} },
    });

    const initrdOp = pathsObj['/api/initrd/{build_name}']!['get']!;
    expect(initrdOp['tags']).toEqual(['Downloads']);
    expect(initrdOp['parameters']).toEqual([
      { name: 'build_name', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('omits excluded entries from the spec', () => {
    apiDoc({ method: 'get', path: '/apispec.json', exclude: true });
    apiDoc({ method: 'get', path: '/api/health', summary: 'Health' });
    const spec = buildOpenApiSpec(options);
    expect(Object.keys(spec['paths'] ?? {})).toEqual(['/api/health']);
  });

  it('includes securitySchemes in components when provided', () => {
    apiDoc({ method: 'get', path: '/api/health' });
    const spec = buildOpenApiSpec({ ...options, securitySchemes: { mtls: { type: 'mutualTLS' } } });
    expect(spec['components']).toEqual({ securitySchemes: { mtls: { type: 'mutualTLS' } } });
  });
});

describe('api-doc schema-aware spec', () => {
  afterEach(() => {
    resetApiDocs();
  });

  it('schemaRef yields a $ref pointing into components/schemas', () => {
    expect(schemaRef(SimpleModel)).toEqual({ $ref: '#/components/schemas/SimpleModel' });
  });

  it('cleanSchema strips title and preserves the rest', () => {
    expect(cleanSchema({ title: 'X', type: 'string' })).toEqual({ type: 'string' });
    expect(cleanSchema({ type: 'integer', minimum: 0, description: 'x' })).toEqual({
      type: 'integer',
      minimum: 0,
      description: 'x',
    });
    expect(cleanSchema({})).toEqual({});
  });

  it('buildQueryParams emits per-field parameters with description carried across', () => {
    const params = buildQueryParams(QueryParams);
    const byName = new Map(params.map((p) => [p['name'] as string, p]));
    expect(byName.has('limit')).toBe(true);
    expect(byName.has('cursor')).toBe(true);
    for (const p of params) {
      expect(p['in']).toBe('query');
      const schemaProp = p['schema'] as Record<string, unknown>;
      expect(schemaProp['title']).toBeUndefined();
    }
    const limit = byName.get('limit')!;
    expect(limit['description']).toBe('Max results');
  });

  it('buildQueryParams flags required vs optional', () => {
    const Q: NamedZodSchema = {
      name: 'Q',
      schema: z.object({ required: z.string(), optional: z.string().optional() }),
    };
    const params = buildQueryParams(Q);
    const byName = new Map(params.map((p) => [p['name'] as string, p]));
    expect(byName.get('required')!['required']).toBe(true);
    expect(byName.get('optional')!['required']).toBe(false);
  });

  it('collectComponentSchemas hoists nested $defs and strips titles', () => {
    const Inner: NamedZodSchema = { name: 'Inner', schema: z.object({ flag: z.boolean() }) };
    const Outer: NamedZodSchema = {
      name: 'Outer',
      schema: z.object({ inner: Inner.schema, items: z.array(Inner.schema).default([]) }),
    };
    apiDoc({ method: 'get', path: '/api/health/outer', summary: 'outer', responses: { 200: Outer } });
    const spec = buildOpenApiSpec(options);
    const components = spec['components'] as Record<string, unknown>;
    const schemas = components['schemas'] as Record<string, Record<string, unknown>>;
    expect(schemas['Outer']).toBeDefined();
    expect(schemas['Outer']!['title']).toBeUndefined();
  });

  it('collectComponentSchemas dedupes by name', () => {
    const A: NamedZodSchema = { name: 'A', schema: z.object({ x: z.number() }) };
    const A2: NamedZodSchema = { name: 'A', schema: z.object({ x: z.number(), y: z.number() }) };
    const out = collectComponentSchemas([A, A2]);
    expect(Object.keys(out)).toEqual(['A']);
  });

  it('request body emits $ref under application/json', () => {
    apiDoc({
      method: 'post',
      path: '/api/bridge/foo',
      summary: 'Create foo',
      request: SimpleModel,
      responses: { 200: SimpleModel },
    });
    const spec = buildOpenApiSpec(options);
    const op = ((spec['paths'] as Record<string, unknown>)['/api/bridge/foo'] as Record<string, unknown>)[
      'post'
    ] as Record<string, unknown>;
    const body = op['requestBody'] as Record<string, unknown>;
    expect(body['required']).toBe(true);
    expect(body['content']).toEqual({ 'application/json': { schema: { $ref: '#/components/schemas/SimpleModel' } } });
    expect(op['tags']).toEqual(['Bridge Management']);
  });

  it('form body emits $ref under application/x-www-form-urlencoded', () => {
    apiDoc({
      method: 'post',
      path: '/api/oob/upload',
      summary: 'Upload',
      form: SimpleModel,
      responses: { 200: SimpleModel },
    });
    const spec = buildOpenApiSpec(options);
    const op = ((spec['paths'] as Record<string, unknown>)['/api/oob/upload'] as Record<string, unknown>)[
      'post'
    ] as Record<string, unknown>;
    const body = op['requestBody'] as Record<string, unknown>;
    const content = body['content'] as Record<string, unknown>;
    expect(content['application/x-www-form-urlencoded']).toEqual({
      schema: { $ref: '#/components/schemas/SimpleModel' },
    });
    expect(op['tags']).toEqual(['Out of Band Management']);
  });

  it('octet-stream response uses {type: string, format: binary} schema', () => {
    apiDoc({
      method: 'get',
      path: '/api/initrd',
      summary: 'Download initrd',
      contentType: 'application/octet-stream',
      responses: { 200: SimpleModel },
    });
    const spec = buildOpenApiSpec(options);
    const op = ((spec['paths'] as Record<string, unknown>)['/api/initrd'] as Record<string, unknown>)['get'] as Record<
      string,
      unknown
    >;
    const responses = op['responses'] as Record<string, Record<string, unknown>>;
    const content = responses['200']!['content'] as Record<string, unknown>;
    expect(content['application/octet-stream']).toEqual({ schema: { type: 'string', format: 'binary' } });
  });

  it('text/plain response uses {type: string} schema', () => {
    apiDoc({
      method: 'get',
      path: '/api/grub',
      summary: 'GRUB',
      contentType: 'text/plain',
      responses: { 200: SimpleModel },
    });
    const spec = buildOpenApiSpec(options);
    const op = ((spec['paths'] as Record<string, unknown>)['/api/grub'] as Record<string, unknown>)['get'] as Record<
      string,
      unknown
    >;
    const responses = op['responses'] as Record<string, Record<string, unknown>>;
    const content = responses['200']!['content'] as Record<string, unknown>;
    expect(content['text/plain']).toEqual({ schema: { type: 'string' } });
  });

  it('response description uses the model description when provided, else the name', () => {
    apiDoc({
      method: 'get',
      path: '/api/health/d',
      summary: 'D',
      responses: { 200: SimpleModel, 400: ErrorResponse },
    });
    const spec = buildOpenApiSpec(options);
    const op = ((spec['paths'] as Record<string, unknown>)['/api/health/d'] as Record<string, unknown>)[
      'get'
    ] as Record<string, unknown>;
    const responses = op['responses'] as Record<string, Record<string, unknown>>;
    expect(responses['200']!['description']).toBe('SimpleModel');
    expect(responses['400']!['description']).toBe('Standard error response.');
  });

  it('query model populates components.schemas alongside operation parameters', () => {
    apiDoc({
      method: 'get',
      path: '/api/ping',
      summary: 'Ping things',
      query: QueryParams,
      responses: { 200: SimpleModel },
    });
    const spec = buildOpenApiSpec(options);
    const op = ((spec['paths'] as Record<string, unknown>)['/api/ping'] as Record<string, unknown>)['get'] as Record<
      string,
      unknown
    >;
    const params = op['parameters'] as Array<Record<string, unknown>>;
    const names = new Set(params.map((p) => p['name']));
    expect(names.has('limit')).toBe(true);
    expect(names.has('cursor')).toBe(true);
    const components = spec['components'] as Record<string, unknown>;
    const schemas = components['schemas'] as Record<string, unknown>;
    expect(schemas['QueryParams']).toBeDefined();
  });

  it('repeated model references emit one component entry', () => {
    apiDoc({ method: 'get', path: '/api/health/a', summary: 'a', responses: { 200: SimpleModel } });
    apiDoc({ method: 'get', path: '/api/health/b', summary: 'b', responses: { 200: SimpleModel } });
    const spec = buildOpenApiSpec(options);
    const schemas = (spec['components'] as Record<string, unknown>)['schemas'] as Record<string, unknown>;
    expect(schemas['SimpleModel']).toBeDefined();
    const a = ((spec['paths'] as Record<string, unknown>)['/api/health/a'] as Record<string, unknown>)['get'] as Record<
      string,
      unknown
    >;
    const b = ((spec['paths'] as Record<string, unknown>)['/api/health/b'] as Record<string, unknown>)['get'] as Record<
      string,
      unknown
    >;
    const refA = (
      ((a['responses'] as Record<string, unknown>)['200'] as Record<string, unknown>)['content'] as Record<
        string,
        unknown
      >
    )['application/json'];
    const refB = (
      ((b['responses'] as Record<string, unknown>)['200'] as Record<string, unknown>)['content'] as Record<
        string,
        unknown
      >
    )['application/json'];
    expect(refA).toEqual(refB);
  });

  it('multiple response codes coexist on one operation', () => {
    apiDoc({
      method: 'get',
      path: '/api/health/q',
      summary: 'q',
      query: QueryParams,
      request: SimpleModel,
      responses: { 200: SimpleModel, 400: ErrorResponse },
    });
    const spec = buildOpenApiSpec(options);
    const schemas = (spec['components'] as Record<string, unknown>)['schemas'] as Record<string, unknown>;
    expect(schemas['QueryParams']).toBeDefined();
    expect(schemas['SimpleModel']).toBeDefined();
    expect(schemas['ErrorResponse']).toBeDefined();
    const op = ((spec['paths'] as Record<string, unknown>)['/api/health/q'] as Record<string, unknown>)[
      'get'
    ] as Record<string, unknown>;
    const responses = op['responses'] as Record<string, unknown>;
    expect(Object.keys(responses).sort()).toEqual(['200', '400']);
  });
});
