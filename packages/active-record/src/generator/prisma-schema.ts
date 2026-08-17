import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCALAR_TYPES = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes']);

export type FieldKind = 'scalar' | 'enum' | 'relation' | 'unknown';

export interface ParsedField {
  name: string;
  baseType: string;
  isList: boolean;
  isOptional: boolean;
  kind: FieldKind;
  isId: boolean;
  hasDefault: boolean;
  isUpdatedAt: boolean;
  isUnique: boolean;
}

export interface ParsedModel {
  name: string;
  fields: ParsedField[];
}

export interface ParsedSchema {
  models: Map<string, ParsedModel>;
  enums: Set<string>;
}

const MODEL_OPEN = /^model\s+(\w+)\s*\{/;
const ENUM_OPEN = /^enum\s+(\w+)\s*\{/;

export function loadSchema(modelsDir: string): ParsedSchema {
  const files = readdirSync(modelsDir).filter((f) => f.endsWith('.prisma'));

  const modelNames = new Set<string>();
  const enums = new Set<string>();
  const rawModelBodies = new Map<string, string[]>();

  for (const file of files) {
    const text = readFileSync(join(modelsDir, file), 'utf8');
    const lines = text.split('\n');
    let mode: 'model' | 'enum' | null = null;
    let currentModel: string | null = null;
    let body: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (mode === null) {
        const modelMatch = line.match(MODEL_OPEN);
        if (modelMatch) {
          mode = 'model';
          currentModel = modelMatch[1];
          modelNames.add(currentModel);
          body = [];
          continue;
        }
        const enumMatch = line.match(ENUM_OPEN);
        if (enumMatch) {
          mode = 'enum';
          enums.add(enumMatch[1]);
        }
        continue;
      }

      if (line === '}') {
        if (mode === 'model' && currentModel) {
          rawModelBodies.set(currentModel, body);
        }
        mode = null;
        currentModel = null;
        continue;
      }

      if (mode === 'model') {
        body.push(line);
      }
    }
  }

  const models = new Map<string, ParsedModel>();
  for (const [name, body] of rawModelBodies) {
    models.set(name, { name, fields: parseFields(body, modelNames, enums) });
  }

  return { models, enums };
}

function parseFields(body: string[], modelNames: Set<string>, enums: Set<string>): ParsedField[] {
  const fields: ParsedField[] = [];
  for (const line of body) {
    if (line === '' || line.startsWith('//') || line.startsWith('@@') || line.startsWith('{') || line === '}') {
      continue;
    }
    const tokens = line.split(/\s+/);
    const name = tokens[0];
    const typeToken = tokens[1];
    if (!name || !typeToken || !/^[A-Za-z_]\w*$/.test(name)) continue;

    const isList = typeToken.includes('[]');
    const isOptional = typeToken.includes('?');
    const baseType = typeToken.replace(/[?[\]]/g, '');
    const attributes = tokens.slice(2).join(' ');

    let kind: FieldKind;
    if (SCALAR_TYPES.has(baseType)) kind = 'scalar';
    else if (enums.has(baseType)) kind = 'enum';
    else if (modelNames.has(baseType)) kind = 'relation';
    else kind = 'unknown';

    fields.push({
      name,
      baseType,
      isList,
      isOptional,
      kind,
      isId: /@id\b/.test(attributes),
      hasDefault: /@default\b/.test(attributes),
      isUpdatedAt: /@updatedAt\b/.test(attributes),
      isUnique: /@unique\b/.test(attributes),
    });
  }
  return fields;
}
