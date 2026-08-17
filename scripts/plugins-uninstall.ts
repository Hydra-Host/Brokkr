#!/usr/bin/env tsx

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

interface Args {
  pluginId: string;
  dryRun: boolean;
  force: boolean;
  keepData: boolean;
  databaseUrl: string | undefined;
  schemaNameOverride: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let dryRun = false;
  let force = false;
  let keepData = false;
  let databaseUrl: string | undefined;
  let schemaNameOverride: string | undefined;

  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--force') force = true;
    else if (arg === '--keep-data') keepData = true;
    else if (arg.startsWith('--database-url=')) databaseUrl = arg.slice('--database-url='.length);
    else if (arg.startsWith('--schema-name=')) schemaNameOverride = arg.slice('--schema-name='.length);
    else if (arg.startsWith('--')) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    console.error(
      'Usage: pnpm plugins:uninstall <plugin-id> [--dry-run|--force|--keep-data|--database-url=...|--schema-name=...]',
    );
    process.exit(2);
  }

  return {
    pluginId: positional[0]!,
    dryRun,
    force,
    keepData,
    databaseUrl,
    schemaNameOverride,
  };
}

interface PluginInfo {
  id: string;
  schemaName: string;
  packageName: string | undefined;
}

interface PluginConfigEntry {
  plugin: {
    id: string;
    schemaName: string;
  };
}

interface PluginManifestLike {
  id: string;
  schemaName: string;
}

function isPluginConfigEntry(value: unknown): value is PluginConfigEntry {
  if (typeof value !== 'object' || value === null) return false;
  if (!('plugin' in value)) return false;

  const pluginValue = Reflect.get(value, 'plugin');
  if (typeof pluginValue !== 'object' || pluginValue === null) return false;

  const id = Reflect.get(pluginValue, 'id');
  const schemaName = Reflect.get(pluginValue, 'schemaName');
  return typeof id === 'string' && typeof schemaName === 'string';
}

function readPluginConfigEntries(value: unknown): PluginConfigEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => isPluginConfigEntry(item));
}

function isPluginManifestLike(value: unknown): value is PluginManifestLike {
  if (typeof value !== 'object' || value === null) return false;
  const id = Reflect.get(value, 'id');
  const schemaName = Reflect.get(value, 'schemaName');
  return typeof id === 'string' && typeof schemaName === 'string';
}

async function resolvePackageNameFromPluginsConfigDeps(pluginId: string): Promise<string | undefined> {
  const pluginsConfigPackageJsonPath = resolvePath(process.cwd(), 'packages', 'plugins-config', 'package.json');

  try {
    const raw = await readFile(pluginsConfigPackageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    const dependencyNames = [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.optionalDependencies ?? {}),
    ];

    for (const dependencyName of dependencyNames) {
      if (!dependencyName.includes('plugin')) continue;

      try {
        const mod = await import(dependencyName);
        const exportValues: unknown[] = [mod.default, ...Object.values(mod)];
        const manifest = exportValues.find((candidate) => {
          if (!isPluginManifestLike(candidate)) return false;
          return candidate.id === pluginId;
        });
        if (manifest) {
          return dependencyName;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`[plugins:uninstall] Plugin manifest probe for ${dependencyName} failed (${errorMessage}).`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(
      `[plugins:uninstall] Failed reading plugins-config package.json (${errorMessage}). Falling back to convention.`,
    );
  }

  return undefined;
}

async function resolvePluginInfo(pluginId: string, schemaNameOverride: string | undefined): Promise<PluginInfo> {
  let foundSchema: string | undefined;
  let foundPackage: string | undefined;

  const distPath = resolvePath(process.cwd(), 'packages', 'plugins-config', 'dist', 'index.js');

  if (existsSync(distPath)) {
    try {
      const mod = await import(pathToFileURL(distPath).href);
      const entries = readPluginConfigEntries(mod.default);
      const entry = entries.find((e) => e.plugin.id === pluginId);
      if (entry) {
        foundSchema = entry.plugin.schemaName;
        foundPackage = await resolvePackageNameFromPluginsConfigDeps(pluginId);
        if (!foundPackage) {
          foundPackage = inferPackageName(pluginId);
        }
      } else {
        console.error(
          `[plugins:uninstall] Plugin "${pluginId}" not found in plugins-config. Falling back to convention.`,
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[plugins:uninstall] Failed to read plugins-config dist (${errorMessage}). Falling back to convention.`,
      );
    }
  } else {
    console.error(
      '[plugins:uninstall] plugins-config dist not built. Run `pnpm --filter @hydrahost/plugins-config build` for a precise schema lookup,',
    );
    console.error('  or pass --schema-name=<name> to bypass.');
  }

  const schemaName = schemaNameOverride ?? foundSchema ?? `plugin_${pluginId.replace(/-/g, '_')}`;
  return { id: pluginId, schemaName, packageName: foundPackage };
}

function inferPackageName(pluginId: string): string | undefined {
  return `@hydrahost/plugin-${pluginId}`;
}

function readDatabaseUrl(override: string | undefined): string {
  if (override) return override;
  const env = process.env.DATABASE_URL;
  if (env && env.length > 0) return env;
  console.error('[plugins:uninstall] DATABASE_URL is not set. Set it in your env or pass --database-url=...');
  process.exit(2);
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const info = await resolvePluginInfo(args.pluginId, args.schemaNameOverride);

  console.log(`\n[plugins:uninstall] Target plugin: ${info.id}`);
  console.log(`  Postgres schema: ${info.schemaName}`);
  console.log(`  npm package:     ${info.packageName ?? '(unknown — guess based on convention)'}\n`);

  if (args.keepData) {
    console.log('--keep-data passed — leaving Postgres state untouched.');
    printFollowupSteps(info);
    return;
  }

  if (!/^[a-z_][a-z0-9_]*$/i.test(info.schemaName)) {
    console.error(`Refusing to operate on suspicious schema name: ${info.schemaName}`);
    process.exit(2);
  }

  const dropSchemaSql = `DROP SCHEMA IF EXISTS "${info.schemaName}" CASCADE;`;
  const deleteTrackingSql = `DELETE FROM "_brokkr_plugin_migrations" WHERE "plugin_id" = '${info.id.replace(/'/g, "''")}';`;

  console.log('Will execute the following SQL against DATABASE_URL:\n');
  console.log(`  ${dropSchemaSql}`);
  console.log(`  ${deleteTrackingSql}\n`);

  if (args.dryRun) {
    console.log('--dry-run passed — not executing.');
    printFollowupSteps(info);
    return;
  }

  if (!args.force) {
    const ok = await confirm(`This will permanently drop schema "${info.schemaName}" and all its tables. Continue?`);
    if (!ok) {
      console.log('Aborted.');
      process.exit(1);
    }
  }

  const databaseUrl = readDatabaseUrl(args.databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(dropSchemaSql);
    const deleted = await client.query('DELETE FROM "_brokkr_plugin_migrations" WHERE "plugin_id" = $1', [info.id]);
    await client.query('COMMIT');
    console.log(`\n✓ Dropped schema "${info.schemaName}" and removed ${deleted.rowCount ?? 0} tracking row(s).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }

  printFollowupSteps(info);
}

function printFollowupSteps(info: PluginInfo): void {
  const pkg = info.packageName ?? `@hydrahost/plugin-${info.id}`;
  console.log('\nFollowup steps (not automated — do these by hand):');
  console.log('  1. Remove the entry from packages/plugins-config/src/index.ts (backend config)');
  console.log('  2. Remove the entry from packages/plugins-config/src/frontend.ts (frontend config)');
  console.log(`  3. pnpm --filter @hydrahost/plugins-config remove ${pkg}`);
  console.log(
    "  4. Remove the plugin's COPY directives from apps/api/Dockerfile (the dist, package.json, database, and node_modules lines)",
  );
  console.log('  5. Rebuild + restart:');
  console.log('       pnpm --filter @hydrahost/plugins-config build');
  console.log('       pnpm --filter api build');
  console.log('       pnpm --filter web build');
  console.log('       pnpm dev:main\n');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
