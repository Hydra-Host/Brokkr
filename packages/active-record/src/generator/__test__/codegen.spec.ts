import { describe, expect, it } from 'vitest';

import { generate, kebabCase } from '../codegen';
import type { ParsedField, ParsedModel, ParsedSchema } from '../prisma-schema';

const f = (name: string, baseType: string, over: Partial<ParsedField> = {}): ParsedField => ({
  name,
  baseType,
  isList: false,
  isOptional: false,
  kind: 'scalar',
  isId: false,
  hasDefault: false,
  isUpdatedAt: false,
  isUnique: false,
  ...over,
});

const deviceModel: ParsedModel = {
  name: 'Device',
  fields: [
    f('id', 'String', { isId: true }),
    f('name', 'String'),
    f('serial', 'String'),
    f('organizationId', 'String'),
    f('deletedAt', 'DateTime', { isOptional: true }),
    f('role', 'DeviceRole', { kind: 'enum' }),
  ],
};

const baseConfig = {
  modelName: 'Device',
  recordName: 'Device',
  delegateName: 'device',
  tenantField: 'organizationId',
  softDeleteField: 'deletedAt',
  discriminator: 'role: DeviceRole.Server',
};

describe('generate() — policy + schema emission', () => {
  it('emits the full RecordPolicy literal', () => {
    const { record } = generate(deviceModel, baseConfig);
    expect(record).toContain("tenantField: 'organizationId'");
    expect(record).toContain("softDeleteField: 'deletedAt'");
    expect(record).toContain('discriminator: { role: DeviceRole.Server }');
  });

  it('emits a Zod schema column for every scoping column', () => {
    const { record } = generate(deviceModel, baseConfig);
    expect(record).toContain('organizationId: z.string()');
    expect(record).toContain('deletedAt: z.date().nullable()');
    expect(record).toContain('role: z.nativeEnum(DeviceRole)');
  });

  it('force-retains tenant / discriminator / soft-delete columns under a lean --fields that omits them', () => {
    const { record } = generate(deviceModel, { ...baseConfig, fields: ['name'] });
    expect(record).toContain('name: z.string()');
    expect(record).toContain('organizationId: z.string()');
    expect(record).toContain('deletedAt: z.date().nullable()');
    expect(record).toContain('role: z.nativeEnum(DeviceRole)');
    expect(record).not.toContain('serial:');
  });

  it('omits the policy block entirely when no scoping is configured', () => {
    const { record } = generate(deviceModel, {
      modelName: 'Device',
      recordName: 'Device',
      delegateName: 'device',
    });
    expect(record).not.toContain('tenantField');
    expect(record).not.toContain('discriminator');
  });
});

describe('generate() — spec emits a tenant-scope assertion', () => {
  it('asserts findMany is called with the tenant pin for a simple tenantField', () => {
    const { spec } = generate(deviceModel, baseConfig);
    expect(spec).toContain('expect(mockDelegate.findMany).toHaveBeenCalledWith(');
    expect(spec).toContain("expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-1' }) })");
  });

  it('nests the matcher for a relation-path tenantField', () => {
    const { spec } = generate(deviceModel, { ...baseConfig, tenantField: 'circuit.organizationId' });
    expect(spec).toContain(
      "expect.objectContaining({ circuit: expect.objectContaining({ organizationId: 'org-1' }) })",
    );
  });

  it('emits no scope assertion when the record is not tenant-scoped', () => {
    const { spec } = generate(deviceModel, { modelName: 'Device', recordName: 'Device', delegateName: 'device' });
    expect(spec).not.toContain('toHaveBeenCalledWith');
  });
});

describe('generate() — MTI extension', () => {
  const pduModel: ParsedModel = {
    name: 'Pdu',
    fields: [
      f('id', 'String', { isId: true }),
      f('deviceId', 'String'),
      f('device', 'Device', { kind: 'relation' }),
      f('outlets', 'Int'),
    ],
  };
  const deviceWithRel: ParsedModel = {
    name: 'Device',
    fields: [...deviceModel.fields, f('pdu', 'Pdu', { kind: 'relation' })],
  };
  const schema: ParsedSchema = {
    models: new Map([
      ['Device', deviceWithRel],
      ['Pdu', pduModel],
    ]),
    enums: new Set(['DeviceRole']),
  };

  it('resolves the extension into the policy and nests its columns minus the back-FK', () => {
    const { record, warnings } = generate(deviceWithRel, { ...baseConfig, extensionRelation: 'pdu' }, schema);
    expect(record).toContain("extension: { relationName: 'pdu' }");
    expect(record).toContain('pdu: z.object({');
    expect(record).toContain('outlets: z.number()');
    expect(record).not.toContain('deviceId:');
    expect(warnings.join('\n')).toMatch(/MTI create/);
  });
});

describe('kebabCase', () => {
  it('converts PascalCase record names to kebab file names', () => {
    expect(kebabCase('RackRole')).toBe('rack-role');
    expect(kebabCase('Device')).toBe('device');
    expect(kebabCase('IPMIConfig')).toBe('ipmi-config');
  });
});
