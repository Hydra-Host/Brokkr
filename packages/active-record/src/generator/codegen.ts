import { ParsedField, ParsedModel, ParsedSchema } from './prisma-schema';

export interface RecordGenConfig {
  modelName: string;
  recordName: string;
  delegateName: string;
  tenantField?: string;
  softDeleteField?: string;
  discriminator?: string;
  fields?: string[];
  extensionRelation?: string;
}

export interface GeneratedFiles {
  record: string;
  spec: string;
  warnings: string[];
}

interface ResolvedExtension {
  relationName: string;
  model: ParsedModel;
  backFk: string;
}

const SCALAR_ZOD: Record<string, string> = {
  String: 'z.string()',
  Boolean: 'z.boolean()',
  Int: 'z.number()',
  Float: 'z.number()',
  BigInt: 'z.bigint()',
  DateTime: 'z.date()',
  Decimal: 'z.unknown()',
  Json: 'z.unknown()',
  Bytes: 'z.unknown()',
};

function zodForField(field: ParsedField): string {
  const base =
    field.kind === 'enum' ? `z.nativeEnum(${field.baseType})` : (SCALAR_ZOD[field.baseType] ?? 'z.unknown()');
  let expr = field.isList ? `z.array(${base})` : base;
  if (field.isOptional) expr += '.nullable()';
  return expr;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function allColumnFields(model: ParsedModel): ParsedField[] {
  return model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum');
}

function policyColumns(config: RecordGenConfig): Set<string> {
  const cols = new Set<string>();
  if (config.softDeleteField) cols.add(config.softDeleteField);
  if (config.tenantField && !config.tenantField.includes('.')) cols.add(config.tenantField);
  if (config.discriminator) {
    for (const part of config.discriminator.split(',')) {
      const key = part.split(':')[0]?.trim();
      if (key) cols.add(key);
    }
  }
  return cols;
}

function baseColumnFields(model: ParsedModel, config: RecordGenConfig): ParsedField[] {
  const all = allColumnFields(model);
  if (!config.fields || config.fields.length === 0) return all;
  const keep = new Set<string>([...config.fields, 'id', ...policyColumns(config)]);
  return all.filter((f) => keep.has(f.name));
}

function extensionColumnFields(ext: ResolvedExtension): ParsedField[] {
  return allColumnFields(ext.model).filter((f) => f.name !== ext.backFk);
}

function resolveExtension(
  model: ParsedModel,
  config: RecordGenConfig,
  schema: ParsedSchema | undefined,
): ResolvedExtension | null {
  if (!config.extensionRelation) return null;
  if (!schema) throw new Error('internal: extension resolution requires the parsed schema');
  const relField = model.fields.find((f) => f.name === config.extensionRelation && f.kind === 'relation');
  if (!relField) {
    throw new Error(`--extension '${config.extensionRelation}' is not a relation field on model ${model.name}.`);
  }
  const extModel = schema.models.get(relField.baseType);
  if (!extModel) {
    throw new Error(
      `Extension model '${relField.baseType}' (relation '${config.extensionRelation}') not found in schema.`,
    );
  }
  const backRel = extModel.fields.find((f) => f.kind === 'relation' && f.baseType === model.name);
  const backFk = backRel ? `${backRel.name}Id` : `${lowerFirst(model.name)}Id`;
  return { relationName: config.extensionRelation, model: extModel, backFk };
}

export function kebabCase(recordName: string): string {
  return recordName
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function aggregateIncludeName(ext: ResolvedExtension): string {
  return `${ext.relationName}AggregateInclude`;
}

function renderAggregateInclude(config: RecordGenConfig, ext: ResolvedExtension | null): string {
  if (!ext) return '';
  return `const ${aggregateIncludeName(ext)} = {
  ${ext.relationName}: true,
} satisfies Prisma.${config.modelName}Include;`;
}

function buildPolicy(config: RecordGenConfig, ext: ResolvedExtension | null): string | null {
  const entries: string[] = [];
  if (config.tenantField) entries.push(`tenantField: '${config.tenantField}'`);
  if (config.softDeleteField) entries.push(`softDeleteField: '${config.softDeleteField}'`);
  if (config.discriminator) entries.push(`discriminator: { ${config.discriminator} }`);
  if (ext) {
    entries.push(`extension: { relationName: '${ext.relationName}' }`);
    entries.push(`include: ${aggregateIncludeName(ext)}`);
  }
  if (entries.length === 0) return null;
  return `{ ${entries.join(', ')} }`;
}

function pickOrderField(model: ParsedModel, config: RecordGenConfig): string {
  const names = new Set(baseColumnFields(model, config).map((f) => f.name));
  if (names.has('name')) return 'name';
  if (names.has('createdAt')) return 'createdAt';
  return 'id';
}

function usedEnums(model: ParsedModel, config: RecordGenConfig, ext: ResolvedExtension | null): string[] {
  const set = new Set<string>();
  for (const f of baseColumnFields(model, config)) {
    if (f.kind === 'enum') set.add(f.baseType);
  }
  if (ext) {
    for (const f of extensionColumnFields(ext)) {
      if (f.kind === 'enum') set.add(f.baseType);
    }
  }
  return [...set].sort();
}

function renderImports(model: ParsedModel, config: RecordGenConfig, ext: ResolvedExtension | null): string {
  const lines = [
    "import { NotFoundException } from '@nestjs/common';",
    "import { createActiveRecord } from '@repo/active-record';",
  ];
  const dbImports = [...(ext ? ['Prisma'] : []), ...usedEnums(model, config, ext)];
  if (dbImports.length > 0) {
    lines.push(`import { ${dbImports.join(', ')} } from '@repo/database';`);
  }
  lines.push("import { z } from 'zod';");
  return lines.join('\n');
}

function renderSchema(model: ParsedModel, config: RecordGenConfig, ext: ResolvedExtension | null): string {
  const lines = baseColumnFields(model, config).map((f) => `  ${f.name}: ${zodForField(f)},`);
  if (ext) {
    const extLines = extensionColumnFields(ext)
      .map((f) => `    ${f.name}: ${zodForField(f)},`)
      .join('\n');
    lines.push(`  ${ext.relationName}: z.object({\n${extLines}\n  }),`);
  }
  return `const ${config.recordName}PersistenceSchema = z.object({\n${lines.join('\n')}\n});`;
}

function renderCrud(config: RecordGenConfig, ext: ResolvedExtension | null, warnings: string[]): string {
  const { recordName } = config;
  const isRelationPathTenant = !!config.tenantField && config.tenantField.includes('.');
  const inputType = `Partial<z.infer<typeof ${recordName}PersistenceSchema>>`;

  let create: string;
  let del = '';

  if (ext) {
    warnings.push(
      `--extension '${ext.relationName}': MTI create doesn't map onto build() — create() was emitted as a stub. ` +
        `Implement the role-upgrade transaction via ActiveRecordRegistry.client (see AdminSwitchRecord.create). ` +
        `Do NOT add an extension detach — removal is a soft-delete of the base Device, which keeps the extension.`,
    );
    create = `  static async create(_input: ${inputType}): Promise<${recordName}Record> {
    // TODO: MTI upgrade — within a transaction, set the discriminator on an
    // existing base row and create its '${ext.relationName}' extension row via
    // ActiveRecordRegistry.client. build() would INSERT a brand-new base row
    // instead of extending one. See AdminSwitchRecord.create.
    throw new Error('create() not implemented for MTI extension record');
  }`;
  } else {
    if (isRelationPathTenant) {
      warnings.push(
        `Tenant policy is a relation path ('${config.tenantField}'): create() was emitted as a stub. ` +
          `build() cannot auto-fill a parent tenant — implement create explicitly (see CircuitTerminationRecord.create).`,
      );
      create = `  static async create(_input: ${inputType}): Promise<${recordName}Record> {
    // TODO: relation-path tenant policy ('${config.tenantField}') — build() does not
    // auto-fill the parent tenant. Implement create explicitly: verify the parent is
    // reachable from the caller's org, then persist. See CircuitTerminationRecord.create.
    throw new Error('create() not implemented for relation-path tenant record');
  }`;
    } else {
      create = `  static async create(input: ${inputType}): Promise<${recordName}Record> {
    const record: ${recordName}Record = this.build(input);
    await record.save();
    return record;
  }`;
    }
    del = `  static async deleteById(id: string): Promise<void> {
    const record = await this.findByIdOrThrow(id);
    await record.delete();
  }`;
  }

  const methods = [
    `  static async findByIdOrThrow(id: string): Promise<${recordName}Record> {
    const record = await this.findById(id);
    if (!record) {
      throw new NotFoundException('${recordName} record not found');
    }
    return record;
  }`,
    create,
    `  static async updateById(id: string, input: ${inputType}): Promise<${recordName}Record> {
    const record = await this.findByIdOrThrow(id);
    record.set(input);
    await record.save();
    return record;
  }`,
  ];
  if (del) methods.push(del);

  return methods.join('\n\n');
}

function renderRecord(
  model: ParsedModel,
  config: RecordGenConfig,
  ext: ResolvedExtension | null,
  warnings: string[],
): string {
  const { recordName, delegateName } = config;
  const policy = buildPolicy(config, ext);
  const extendsArgs = policy
    ? `${recordName}PersistenceSchema, '${delegateName}', ${policy}`
    : `${recordName}PersistenceSchema, '${delegateName}'`;
  const orderField = pickOrderField(model, config);

  const aggregateInclude = renderAggregateInclude(config, ext);

  return `${renderImports(model, config, ext)}

${aggregateInclude ? `${aggregateInclude}\n\n` : ''}${renderSchema(model, config, ext)}

export class ${recordName}Record extends createActiveRecord(${extendsArgs}) {
  static async list(): Promise<${recordName}Record[]> {
    return this.findMany({ orderBy: { ${orderField}: 'asc' } });
  }

${renderCrud(config, ext, warnings)}
}
`;
}

function sampleValue(field: ParsedField, config: RecordGenConfig): string {
  if (field.isOptional) return 'null';
  if (field.isList) return '[]';
  switch (field.kind) {
    case 'enum':
      return `Object.values(${field.baseType})[0]`;
    case 'scalar':
      switch (field.baseType) {
        case 'String':
          return field.name === 'id' ? `'${config.delegateName}-1'` : `'${field.name}'`;
        case 'Boolean':
          return 'false';
        case 'Int':
        case 'Float':
          return '0';
        case 'BigInt':
          return 'BigInt(0)';
        case 'DateTime':
          return 'new Date()';
        default:
          return 'null';
      }
    default:
      return 'null';
  }
}

function tenantWhereMatcher(tenantField: string): string {
  let matcher = "'org-1'";
  for (const segment of tenantField.split('.').reverse()) {
    matcher = `expect.objectContaining({ ${segment}: ${matcher} })`;
  }
  return matcher;
}

function renderSpec(model: ParsedModel, config: RecordGenConfig, ext: ResolvedExtension | null): string {
  const { recordName, delegateName } = config;
  const kebab = kebabCase(recordName);
  const hasTenant = !!config.tenantField;

  const requiredEnumsOf = (fields: ParsedField[]): string[] =>
    fields.filter((f) => f.kind === 'enum' && !f.isOptional && !f.isList).map((f) => f.baseType);
  const requiredEnums = [
    ...new Set([
      ...requiredEnumsOf(baseColumnFields(model, config)),
      ...(ext ? requiredEnumsOf(extensionColumnFields(ext)) : []),
    ]),
  ].sort();

  const importLines = [
    "import { NotFoundException } from '@nestjs/common';",
    "import { ActiveRecordRegistry } from '@repo/active-record';",
  ];
  if (requiredEnums.length > 0) {
    importLines.push(`import { ${requiredEnums.join(', ')} } from '@repo/database';`);
  }
  importLines.push("import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';");
  importLines.push(`import { ${recordName}Record } from '../${kebab}.record';`);

  const sampleLines = baseColumnFields(model, config).map((f) => `    ${f.name}: ${sampleValue(f, config)},`);
  if (ext) {
    const extSample = extensionColumnFields(ext)
      .map((f) => `      ${f.name}: ${sampleValue(f, config)},`)
      .join('\n');
    sampleLines.push(`    ${ext.relationName}: {\n${extSample}\n    },`);
  }

  const configureCall = hasTenant
    ? `ActiveRecordRegistry.configureForTest({ ${delegateName}: mockDelegate }, () => ({ organizationId: 'org-1' }));`
    : `ActiveRecordRegistry.configureForTest({ ${delegateName}: mockDelegate });`;

  // The spec must assert the tenant pin reaches findMany — list() returning rows passes regardless of scoping.
  const tenantListAssertion = config.tenantField
    ? `
    expect(mockDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: ${tenantWhereMatcher(config.tenantField)} }),
    );`
    : '';

  return `${importLines.join('\n')}

describe('${recordName}Record', () => {
  const mockDelegate = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const sample = {
${sampleLines.join('\n')}
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ${configureCall}
  });

  afterEach(() => vi.clearAllMocks());

  it('finds by id or throws', async () => {
    mockDelegate.findFirst.mockResolvedValueOnce(sample);
    const found = await ${recordName}Record.findByIdOrThrow(sample.id);
    expect(found.data.id).toBe(sample.id);

    mockDelegate.findFirst.mockResolvedValueOnce(null);
    await expect(${recordName}Record.findByIdOrThrow('missing')).rejects.toThrow(NotFoundException);
  });

  it('lists records', async () => {
    mockDelegate.findMany.mockResolvedValue([sample]);
    const result = await ${recordName}Record.list();
    expect(result).toHaveLength(1);${tenantListAssertion}
  });

  // TODO: add coverage for the mutations (create / updateById, and delete if present).
});
`;
}

export function generate(model: ParsedModel, config: RecordGenConfig, schema?: ParsedSchema): GeneratedFiles {
  const warnings: string[] = [];
  const ext = resolveExtension(model, config, schema);
  const record = renderRecord(model, config, ext, warnings);
  const spec = renderSpec(model, config, ext);
  return { record, spec, warnings };
}
