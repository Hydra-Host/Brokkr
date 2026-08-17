import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { generate, kebabCase, RecordGenConfig } from './codegen';
import { loadSchema, ParsedModel, ParsedSchema } from './prisma-schema';

const DEFAULT_MODELS_DIR = resolve(__dirname, '../../../database/prisma/models');

interface CliArgs {
  model?: string;
  name?: string;
  tenantField?: string;
  softDelete?: string;
  discriminator?: string;
  fields?: string;
  extension?: string;
  out?: string;
  modelsDir: string;
  noSpec: boolean;
  force: boolean;
  listModels: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { modelsDir: DEFAULT_MODELS_DIR, noSpec: false, force: false, listModels: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--':
        break;
      case '--model':
        args.model = next();
        break;
      case '--name':
        args.name = next();
        break;
      case '--tenant-field':
        args.tenantField = next();
        break;
      case '--soft-delete':
        args.softDelete = next();
        break;
      case '--discriminator':
        args.discriminator = next();
        break;
      case '--fields':
        args.fields = next();
        break;
      case '--extension':
        args.extension = next();
        break;
      case '--out':
        args.out = next();
        break;
      case '--models-dir':
        args.modelsDir = resolve(next() ?? '');
        break;
      case '--no-spec':
        args.noSpec = true;
        break;
      case '--force':
        args.force = true;
        break;
      case '--list-models':
        args.listModels = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`Active-record boilerplate generator

Usage (from the repo root):
  pnpm gen:record                                  # interactive wizard (no flags needed)
  pnpm gen:record -- --model <PrismaModel> [options]

Run with no --model on a terminal to launch the interactive wizard: it searches
models, suggests a name, auto-detects extensions / soft-delete / tenant columns,
offers a numbered field picker, and prints the equivalent flag command before
generating. The flags below drive the same generator non-interactively.

Options:
  --model <Name>          Prisma model name, PascalCase (e.g. DcimRackRole). Required.
  --name <RecordName>     Record class base name (default: model name). e.g. RackRole -> RackRoleRecord
  --tenant-field <field>  Tenant-scoping column ('organizationId') or relation path ('circuit.organizationId').
  --soft-delete <field>   Soft-delete column (e.g. deletedAt).
  --discriminator <body>  Verbatim discriminator object body, e.g. "role: DeviceRole.Server".
  --fields <a,b,c>        Lean column allow-list (comma-separated). Only these base columns are
                          emitted; 'id' and any policy columns are always retained. Omit for all.
  --extension <relation>  Fold in a 1:1 MTI extension by its relation field name on the base model
                          (e.g. 'pdu' on Device). Nests the extension's columns under that key and
                          emits an 'extension: { relationName }' policy. create() is stubbed (the MTI
                          role-upgrade doesn't map onto build()); no delete is emitted — removal is a
                          soft-delete of the base Device, never an extension detach.
  --out <file>            Write to <file> (a *.record.ts path). Also writes a spec under __test__/.
                          Without --out the generated code is printed to stdout (preview).
  --no-spec               Skip generating the spec file.
  --force                 Overwrite existing files.
  --models-dir <dir>      Override the Prisma models directory.
  --list-models           List available Prisma model names and exit.
  -h, --help              Show this help.

Examples:
  pnpm gen:record -- --model DcimRackRole --name RackRole
  pnpm gen:record -- --model Deployment --name Deployment \\
    --tenant-field customerId --out apps/api/src/deployments/deployment.record.ts

  # Admin MTI record: lean Device base + nested 'pdu' extension, role-discriminated, soft-deletable.
  pnpm gen:record -- --model Device --name AdminPdu \\
    --discriminator "role: DeviceRole.PDU" --soft-delete deletedAt --extension pdu \\
    --fields name,nickname,systemSerial,chassisSerial,status,role,zoneId,organizationId,createdAt,updatedAt \\
    --out apps/api/src/admin/records/admin-pdu.record.ts
`);
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

type Rl = ReturnType<typeof createInterface>;

async function ask(rl: Rl, prompt: string, defaultValue = ''): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askYesNo(rl: Rl, prompt: string, defaultYes: boolean): Promise<boolean> {
  const answer = (await rl.question(`${prompt} [${defaultYes ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

function formatNumbered(items: string[]): string {
  const width = Math.max(...items.map((s) => s.length)) + 7;
  const perRow = Math.max(1, Math.floor(96 / width));
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += perRow) {
    const row = items
      .slice(i, i + perRow)
      .map((s, j) => `${String(i + j + 1).padStart(3)}. ${s}`.padEnd(width))
      .join('');
    rows.push(`  ${row.trimEnd()}`);
  }
  return rows.join('\n');
}

function scalarAndEnumColumns(model: ParsedModel): string[] {
  return model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name);
}

async function pickModel(rl: Rl, schema: ParsedSchema): Promise<string> {
  const names = [...schema.models.keys()].sort();
  for (;;) {
    const input = (await rl.question('Prisma model (exact name or search text): ')).trim();
    if (!input) {
      process.stdout.write('  Enter a model name or some text to search for.\n');
      continue;
    }
    if (schema.models.has(input)) return input;
    const matches = names.filter((n) => n.toLowerCase().includes(input.toLowerCase()));
    if (matches.length === 0) {
      process.stdout.write(`  No models match "${input}". Try again.\n`);
      continue;
    }
    if (matches.length === 1) return matches[0];
    process.stdout.write(`${formatNumbered(matches)}\n`);
    const sel = (await rl.question(`Select 1-${matches.length} (or press Enter to search again): `)).trim();
    const idx = Number.parseInt(sel, 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= matches.length) return matches[idx - 1];
  }
}

async function pickExtension(rl: Rl, model: ParsedModel): Promise<string | undefined> {
  const toOne = model.fields.filter((f) => f.kind === 'relation' && !f.isList).map((f) => f.name);
  if (toOne.length === 0) return undefined;
  const input = await ask(rl, `Fold in a 1:1 extension? to-one relations: ${toOne.join(', ')} (blank = none)`);
  if (!input) return undefined;
  if (toOne.includes(input)) return input;
  process.stdout.write(`  "${input}" is not a to-one relation on ${model.name}; skipping extension.\n`);
  return undefined;
}

async function pickFields(rl: Rl, model: ParsedModel): Promise<string[] | undefined> {
  const columns = scalarAndEnumColumns(model);
  process.stdout.write(`\nColumns on ${model.name} (${columns.length}):\n${formatNumbered(columns)}\n`);
  const input = (await rl.question('Lean fields — comma-separated names or numbers (blank = all): ')).trim();
  if (!input) return undefined;
  const picked: string[] = [];
  for (const token of input
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)) {
    const num = Number.parseInt(token, 10);
    if (Number.isInteger(num) && num >= 1 && num <= columns.length) {
      picked.push(columns[num - 1]);
    } else if (columns.includes(token)) {
      picked.push(token);
    } else {
      process.stdout.write(`  Ignoring unknown column "${token}".\n`);
    }
  }
  return picked.length > 0 ? [...new Set(picked)] : undefined;
}

function buildCommandPreview(args: CliArgs): string {
  const parts = ['pnpm gen:record --'];
  if (args.model) parts.push(`--model ${args.model}`);
  if (args.name) parts.push(`--name ${args.name}`);
  if (args.discriminator) parts.push(`--discriminator "${args.discriminator}"`);
  if (args.softDelete) parts.push(`--soft-delete ${args.softDelete}`);
  if (args.tenantField) parts.push(`--tenant-field ${args.tenantField}`);
  if (args.extension) parts.push(`--extension ${args.extension}`);
  if (args.fields) parts.push(`--fields ${args.fields}`);
  if (args.out) parts.push(`--out ${args.out}`);
  if (args.noSpec) parts.push('--no-spec');
  if (args.force) parts.push('--force');
  return parts.join(' ');
}

async function runWizard(args: CliArgs, schema: ParsedSchema): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('\nActive-record generator — interactive mode (Ctrl-C to abort)\n\n');

    const modelName = await pickModel(rl, schema);
    args.model = modelName;
    const model = schema.models.get(modelName);
    if (!model) throw new Error(`Model "${modelName}" not found.`);

    args.name = await ask(rl, 'Record class base name', modelName.replace(/^Dcim/, ''));

    const extension = await pickExtension(rl, model);
    if (extension) args.extension = extension;

    const roleEnum = model.fields.find((f) => f.kind === 'enum' && f.name === 'role');
    const discHint = roleEnum ? `e.g. role: ${roleEnum.baseType}.VALUE` : 'e.g. role: DeviceRole.PDU';
    const disc = (await rl.question(`Discriminator body (${discHint}) (blank = none): `)).trim();
    if (disc) args.discriminator = disc;

    if (model.fields.some((f) => f.name === 'deletedAt')) {
      if (await askYesNo(rl, "Soft-delete via 'deletedAt'?", true)) args.softDelete = 'deletedAt';
    } else {
      const sd = (await rl.question('Soft-delete column (blank = none): ')).trim();
      if (sd) args.softDelete = sd;
    }

    const tenantCandidates = ['organizationId', 'supplierId', 'customerId'].filter((c) =>
      model.fields.some((f) => f.name === c),
    );
    const tenantHint = tenantCandidates.length > 0 ? ` (candidates: ${tenantCandidates.join(', ')})` : '';
    const tenant = (await rl.question(`Tenant field${tenantHint} (blank = none / cross-tenant): `)).trim();
    if (tenant) args.tenantField = tenant;

    const fields = await pickFields(rl, model);
    if (fields) args.fields = fields.join(',');

    const looksAdmin = !!args.discriminator || !!args.extension;
    const suggestedOut = looksAdmin ? `apps/api/src/admin/records/${kebabCase(args.name)}.record.ts` : '';
    const outPrompt = suggestedOut ? "Output file ('-' for stdout preview)" : 'Output file (blank = preview to stdout)';
    const out = await ask(rl, outPrompt, suggestedOut);
    if (out && out !== '-') args.out = out;

    if (args.out) {
      args.noSpec = !(await askYesNo(rl, 'Generate spec file too?', true));
      args.force = await askYesNo(rl, 'Overwrite if files exist?', false);
    }

    process.stdout.write(`\nEquivalent non-interactive command:\n  ${buildCommandPreview(args)}\n\n`);
    return await askYesNo(rl, 'Proceed?', true);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const schema = loadSchema(args.modelsDir);

  if (args.listModels) {
    const names = [...schema.models.keys()].sort();
    process.stdout.write(`${names.join('\n')}\n`);
    return;
  }

  if (!args.model && process.stdin.isTTY) {
    const proceed = await runWizard(args, schema);
    if (!proceed) {
      process.stdout.write('Aborted.\n');
      return;
    }
  }

  if (!args.model) {
    throw new Error(
      '--model is required (non-interactive). Run with --list-models to see available models, or --help.',
    );
  }

  const model = schema.models.get(args.model);
  if (!model) {
    const names = [...schema.models.keys()].sort();
    throw new Error(`Model "${args.model}" not found. Available models:\n${names.join('\n')}`);
  }

  const recordName = args.name ?? args.model;
  const config: RecordGenConfig = {
    modelName: args.model,
    recordName,
    delegateName: lowerFirst(args.model),
    tenantField: args.tenantField,
    softDeleteField: args.softDelete,
    discriminator: args.discriminator,
    fields: args.fields
      ?.split(',')
      .map((f) => f.trim())
      .filter(Boolean),
    extensionRelation: args.extension,
  };

  const { record, spec, warnings } = generate(model, config, schema);

  if (!args.out) {
    process.stdout.write(`${record}\n`);
    if (!args.noSpec) {
      process.stdout.write(`\n// ── ${kebabCase(recordName)}.record.spec.ts ${'─'.repeat(20)}\n\n`);
      process.stdout.write(`${spec}\n`);
    }
    emitWarnings(warnings);
    return;
  }

  const recordPath = resolve(args.out);
  writeFile(recordPath, record, args.force);
  process.stderr.write(`Wrote ${recordPath}\n`);

  if (!args.noSpec) {
    const specPath = join(dirname(recordPath), '__test__', `${kebabCase(recordName)}.record.spec.ts`);
    writeFile(specPath, spec, args.force);
    process.stderr.write(`Wrote ${specPath}\n`);
  }

  emitWarnings(warnings);
}

function writeFile(path: string, contents: string, force: boolean): void {
  if (existsSync(path) && !force) {
    throw new Error(`Refusing to overwrite existing file (use --force): ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function emitWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
