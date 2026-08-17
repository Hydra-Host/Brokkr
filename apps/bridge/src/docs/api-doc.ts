import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema as zodToJsonSchemaTyped } from 'zod-to-json-schema';

const zodToJsonSchema = zodToJsonSchemaTyped as unknown as (
  schema: unknown,
  options?: { name?: string; $refStrategy?: 'root' | 'relative' | 'none'; definitionPath?: string } | string,
) => Record<string, unknown>;

export type OpenApiSpec = Record<string, unknown>;

export interface OpenApiSpecOptions {
  title: string;
  version: string;
  info: Readonly<Record<string, unknown>>;
  servers: readonly Readonly<Record<string, unknown>>[];
  securitySchemes: Readonly<Record<string, unknown>> | null;
  security: ReadonlyArray<Readonly<Record<string, unknown>>> | null;
}

export type ApiDocMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface NamedZodSchema {
  name: string;
  schema: ZodTypeAny;
  description?: string;
}

export type SchemaRef = NamedZodSchema | string;

export interface ApiDocEntry {
  method: ApiDocMethod;
  path: string;
  summary?: string;
  tags?: readonly string[];
  contentType?: string;
  request?: NamedZodSchema;
  query?: NamedZodSchema;
  form?: NamedZodSchema;
  responses?: Readonly<Record<number, SchemaRef>>;
  deprecated?: boolean;
  exclude?: boolean;
}

const QUART_PARAM_RE = /<(?:(?:string|int|float|path|uuid):)?([^>]+)>/g;

const TAG_MAP: ReadonlyArray<readonly [string, string]> = [
  ['/api/bridge/', 'Bridge Management'],
  ['/api/lifecycle/', 'Lifecycle Management'],
  ['/api/oob/', 'Out of Band Management'],
  ['/api/chain', 'iPXE Network Boot'],
  ['/api/server/', 'Server Management'],
  ['/api/discovery', 'Downloads'],
  ['/api/initrd', 'Downloads'],
  ['/api/grub', 'Downloads'],
  ['/api/ping', 'Infrastructure Monitoring'],
  ['/api/ipmi', 'Infrastructure Monitoring'],
  ['/api/monitoring/', 'Infrastructure Monitoring'],
  ['/api/network/', 'Network'],
  ['/api/health', 'Health'],
];

const registry: ApiDocEntry[] = [];

export function apiDoc(entry: ApiDocEntry): void {
  const exists = registry.some((e) => e.method === entry.method && e.path === entry.path);
  if (!exists) registry.push(entry);
}

export function registeredApiDocs(): readonly ApiDocEntry[] {
  return registry;
}

export function resetApiDocs(): void {
  registry.length = 0;
}

export function quartToOpenapiPath(rule: string): string {
  return rule.replace(new RegExp(QUART_PARAM_RE.source, 'g'), '{$1}');
}

export function collectPathParams(rule: string): Array<Record<string, unknown>> {
  const params: Array<Record<string, unknown>> = [];
  const re = new RegExp(QUART_PARAM_RE.source, 'g');
  for (const match of rule.matchAll(re)) {
    const name = match[1];
    if (name === undefined) continue;
    params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  }
  return params;
}

export function deriveTags(path: string): string[] {
  for (const [prefix, tag] of TAG_MAP) {
    if (path.startsWith(prefix)) return [tag];
  }
  return ['Other'];
}

export function schemaRef(model: NamedZodSchema): Record<string, unknown> {
  return { $ref: `#/components/schemas/${model.name}` };
}

export function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'title') continue;
    out[k] = v;
  }
  return out;
}

function toJsonSchema(model: NamedZodSchema): {
  root: Record<string, unknown>;
  defs: Record<string, Record<string, unknown>>;
} {
  const result = zodToJsonSchema(model.schema, {
    name: model.name,
    $refStrategy: 'root',
    definitionPath: 'components/schemas',
  });
  const defs = (result['definitions'] ?? result['components/schemas'] ?? {}) as Record<string, Record<string, unknown>>;
  const root = (defs[model.name] ?? result) as Record<string, unknown>;
  const otherDefs: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(defs)) {
    if (k === model.name) continue;
    otherDefs[k] = v;
  }
  const cleanRoot: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(root)) {
    if (k === '$schema' || k === 'definitions' || k === 'components/schemas') continue;
    cleanRoot[k] = v;
  }
  return { root: cleanRoot, defs: otherDefs };
}

export function buildQueryParams(model: NamedZodSchema): Array<Record<string, unknown>> {
  const { root } = toJsonSchema(model);
  const properties = (root['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const requiredArr = (root['required'] ?? []) as readonly string[];
  const requiredSet = new Set(requiredArr);
  const params: Array<Record<string, unknown>> = [];
  for (const [name, prop] of Object.entries(properties)) {
    const param: Record<string, unknown> = {
      name,
      in: 'query',
      required: requiredSet.has(name),
      schema: cleanSchema(prop),
    };
    const desc = prop['description'];
    if (typeof desc === 'string' && desc.length > 0) {
      param['description'] = desc;
    }
    params.push(param);
  }
  return params;
}

export function collectComponentSchemas(models: readonly NamedZodSchema[]): Record<string, Record<string, unknown>> {
  const schemas: Record<string, Record<string, unknown>> = {};
  for (const model of models) {
    const { root, defs } = toJsonSchema(model);
    for (const [defName, defSchema] of Object.entries(defs)) {
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(defSchema)) {
        if (k === 'title') continue;
        cleaned[k] = v;
      }
      schemas[defName] = cleaned;
    }
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(root)) {
      if (k === 'title') continue;
      cleaned[k] = v;
    }
    schemas[model.name] = cleaned;
  }
  return schemas;
}

function isNamedZodSchema(value: SchemaRef): value is NamedZodSchema {
  return typeof value === 'object' && value !== null && 'schema' in value;
}

function buildResponseEntry(value: SchemaRef, contentType: string): Record<string, unknown> {
  if (!isNamedZodSchema(value)) {
    return {
      description: value,
      content: { [contentType]: {} },
    };
  }
  const description = value.description ?? value.name;
  const entry: Record<string, unknown> = { description };
  if (contentType === 'application/json') {
    entry['content'] = { 'application/json': { schema: schemaRef(value) } };
  } else if (contentType === 'application/octet-stream') {
    entry['content'] = { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } };
  } else if (contentType === 'text/plain') {
    entry['content'] = { 'text/plain': { schema: { type: 'string' } } };
  }
  return entry;
}

function buildOperation(entry: ApiDocEntry, modelSink: NamedZodSchema[]): Record<string, unknown> {
  const operation: Record<string, unknown> = {};
  if (entry.summary) operation['summary'] = entry.summary;
  operation['tags'] = entry.tags && entry.tags.length > 0 ? [...entry.tags] : deriveTags(entry.path);
  if (entry.deprecated) operation['deprecated'] = true;
  const parameters = collectPathParams(entry.path);
  if (entry.query) {
    parameters.push(...buildQueryParams(entry.query));
    modelSink.push(entry.query);
  }
  if (parameters.length > 0) operation['parameters'] = parameters;

  if (entry.request) {
    modelSink.push(entry.request);
    operation['requestBody'] = {
      required: true,
      content: { 'application/json': { schema: schemaRef(entry.request) } },
    };
  } else if (entry.form) {
    modelSink.push(entry.form);
    operation['requestBody'] = {
      required: true,
      content: { 'application/x-www-form-urlencoded': { schema: schemaRef(entry.form) } },
    };
  }

  const responses: Record<string, unknown> = {};
  const declared = Object.entries(entry.responses ?? {});
  const respContentType = entry.contentType ?? 'application/json';
  for (const [status, value] of declared) {
    if (isNamedZodSchema(value)) {
      modelSink.push(value);
    }
    responses[status] = buildResponseEntry(value, respContentType);
  }
  if (declared.length === 0) {
    responses['200'] = { description: 'Successful response' };
  }
  operation['responses'] = responses;
  return operation;
}

export function buildOpenApiSpec(options: OpenApiSpecOptions): OpenApiSpec {
  const grouped = new Map<string, Map<string, Record<string, unknown>>>();
  const allModels: NamedZodSchema[] = [];
  for (const entry of registry) {
    if (entry.exclude) continue;
    const key = quartToOpenapiPath(entry.path);
    let item = grouped.get(key);
    if (item === undefined) {
      item = new Map();
      grouped.set(key, item);
    }
    item.set(entry.method, buildOperation(entry, allModels));
  }

  const sortedPaths: Record<string, unknown> = {};
  for (const key of [...grouped.keys()].sort()) {
    const ops = grouped.get(key)!;
    const sortedOps: Record<string, unknown> = {};
    for (const method of [...ops.keys()].sort()) {
      sortedOps[method] = ops.get(method);
    }
    sortedPaths[key] = sortedOps;
  }

  const seen = new Set<string>();
  const uniqueModels: NamedZodSchema[] = [];
  for (const m of allModels) {
    if (seen.has(m.name)) continue;
    uniqueModels.push(m);
    seen.add(m.name);
  }

  const spec: OpenApiSpec = {
    openapi: '3.0.2',
    info: { title: options.title, version: options.version, ...options.info },
    paths: sortedPaths,
  };
  if (options.servers.length > 0) {
    spec['servers'] = options.servers.map((s) => ({ ...s }));
  }
  if (options.security && (options.security as ReadonlyArray<unknown>).length > 0) {
    spec['security'] = (options.security as Array<Record<string, unknown>>).map((s) => ({ ...s }));
  }
  const components: Record<string, unknown> = {};
  if (uniqueModels.length > 0) {
    components['schemas'] = collectComponentSchemas(uniqueModels);
  }
  if (options.securitySchemes !== null && Object.keys(options.securitySchemes).length > 0) {
    components['securitySchemes'] = options.securitySchemes;
  }
  if (Object.keys(components).length > 0) {
    spec['components'] = components;
  }
  return spec;
}
