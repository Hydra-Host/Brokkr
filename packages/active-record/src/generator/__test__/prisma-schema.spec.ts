import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadSchema, type ParsedField, type ParsedModel } from '../prisma-schema';


let dir: string;

const SCHEMA = `
enum DeviceRole {
  Server
  Switch
}

model Device {
  id             String     @id @default(cuid())
  name           String
  organizationId String
  deletedAt      DateTime?
  role           DeviceRole
  tags           Tag[]
  updatedAt      DateTime   @updatedAt
  serial         String?    @unique
  // an inline comment line that must be ignored
  @@index([organizationId])
}

model Tag {
  id      String    @id
  devices Device[]
}
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ar-prisma-'));
  writeFileSync(join(dir, 'schema.prisma'), SCHEMA);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loadSchema / parseFields', () => {
  const fieldOf = (model: ParsedModel, name: string): ParsedField => {
    const f = model.fields.find((x) => x.name === name);
    if (!f) throw new Error(`field ${name} not parsed`);
    return f;
  };

  it('discovers both models and the enum (cross-file name table)', () => {
    const schema = loadSchema(dir);
    expect([...schema.models.keys()].sort()).toEqual(['Device', 'Tag']);
    expect(schema.enums.has('DeviceRole')).toBe(true);
  });

  it('classifies scalar / enum / relation by the model+enum name tables', () => {
    const device = loadSchema(dir).models.get('Device')!;
    expect(fieldOf(device, 'name').kind).toBe('scalar');
    expect(fieldOf(device, 'role').kind).toBe('enum');
    expect(fieldOf(device, 'tags').kind).toBe('relation');
  });

  it('flags optional / list / @id / @default / @updatedAt / @unique', () => {
    const device = loadSchema(dir).models.get('Device')!;
    expect(fieldOf(device, 'id')).toMatchObject({ isId: true, hasDefault: true });
    expect(fieldOf(device, 'deletedAt').isOptional).toBe(true);
    expect(fieldOf(device, 'tags').isList).toBe(true);
    expect(fieldOf(device, 'updatedAt').isUpdatedAt).toBe(true);
    expect(fieldOf(device, 'serial')).toMatchObject({ isOptional: true, isUnique: true });
  });

  it('skips comments and @@-block lines (not parsed as fields)', () => {
    const device = loadSchema(dir).models.get('Device')!;
    const names = device.fields.map((f) => f.name);
    expect(names).not.toContain('@@index');
    expect(names).toContain('organizationId');
  });
});
