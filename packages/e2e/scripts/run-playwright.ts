import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { E2eDatabase } from './e2e-database.js';
import { createE2eDatabase, dropE2eDatabase, validateConnection } from './e2e-database.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '../..');

const run = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    capture?: boolean;
    allowNonZeroExit?: boolean;
  },
) => {
  const result = spawnSync(command, args, {
    cwd: options?.cwd ?? repoRoot,
    env: options?.env ?? process.env,
    encoding: 'utf-8',
    stdio: options?.capture ? 'pipe' : 'inherit',
  });

  if (result.status !== 0 && !options?.allowNonZeroExit) {
    process.exit(result.status ?? 1);
  }

  return result;
};

const expectedWebServerErrorPatterns = [
  /\[WebServer\].*ERROR \[Better Auth\]: Invalid password/,
  /\[WebServer\].*ERROR \[UnifiedIdentityGuard\] Unable to find valid session/,
  /\[WebServer\].*ERROR \[UnifiedIdentityGuard\] Session is missing active organization ID or user ID/,
  /\[WebServer\].*ERROR \[DeploymentsProjectsService\].*Failed to delete deployment project: Default project cannot be deleted/,
  /\[WebServer\].*ERROR \[DeploymentsProjectsService\].*Failed to delete deployment project: Cannot delete the last project/,
  /\[WebServer\].*ERROR \[DeploymentsProjectsService\].*Failed to fetch deployment project: Project .* not found/,
];

const stripAnsi = (value: string): string => value.replace(/\x1B\[[0-9;]*m/g, '');

const getUnexpectedWebServerErrors = (output: string): string[] => {
  const lines = output.split('\n').map((line) => line.trimEnd());
  const normalizedLines = lines.map((line) => stripAnsi(line));
  const webServerErrorLines = normalizedLines.filter((line) => line.includes('[WebServer]') && line.includes('ERROR'));

  return webServerErrorLines.filter((line) => !expectedWebServerErrorPatterns.some((pattern) => pattern.test(line)));
};

let e2eDb: E2eDatabase | undefined;
let cleanupEnvFiles: (() => void) | undefined;

const printPreservedDbInfo = () => {
  if (!e2eDb) return;
  console.error(`\n  E2E database preserved for debugging:`);
  console.error(`    Name: ${e2eDb.name}`);
  console.error(`    URL:  ${e2eDb.databaseUrl}\n`);
};

const handleSignal = (signal: NodeJS.Signals) => {
  console.error(`\nReceived ${signal}.`);
  printPreservedDbInfo();
  cleanupEnvFiles?.();
  process.exit(1);
};

try {
  await validateConnection();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Cannot connect to PostgreSQL: ${message}`);
  console.error('Is PostgreSQL running? Try: pnpm --filter @repo/database db:init');
  process.exit(1);
}

e2eDb = await createE2eDatabase();
console.log(`Created E2E database: ${e2eDb.name}`);

process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);

const runId = process.env.E2E_RUN_ID ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const appEnvDefaults: NodeJS.ProcessEnv = {
  HH_ENV: 'ci',
  IS_LOCAL: 'true',
  AUTH_BYPASS_ENABLED: 'true',
  AUTH_BYPASS_ALLOWED_ENVS: 'dev,ci',
  BROKKR_ADMIN_ORG_ID: '00000000-0000-0000-0000-000000000000',
  REDIS_URL: 'redis://localhost:6379/1',
  BASE_URL: 'http://localhost:5176',
  API_URL: 'http://localhost:3210',
  ADMIN_BASE_URL: 'http://localhost:5177',
  ADMIN_API_URL: 'http://localhost:3211',
  HYDRAHOST_ORGANIZATION_ID: '00000000-0000-0000-0000-000000000000',
  VITE_STRICT_PORT: 'true',
  BROKKR_HUB_PRIVATE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  S3_ACCESS_KEY_ID: 'test',
  S3_BUCKET: 'test',
  S3_SECRET_ACCESS_KEY: 'test',
  S3_ENDPOINT_URL: 'http://localhost',
  BETTER_AUTH_SECRET: 'test',
  DEVICE_TOKEN_PEPPER: 'test',
  DISABLE_WEBHOOK_RETRY_CRON: 'true',
  DISABLE_WEBHOOK_CLEANUP_CRON: 'true',
  DISABLE_AUTH_SESSION_CACHE: 'true',
  SUPPRESS_EXPECTED_AUTH_ERRORS: 'true',
};
const dotenvQuote = (value: string | undefined): string => JSON.stringify(value ?? '');
const baseUrl = process.env.BASE_URL ?? appEnvDefaults.BASE_URL;
const apiUrl = process.env.API_URL ?? appEnvDefaults.API_URL;
const adminBaseUrl = process.env.ADMIN_BASE_URL ?? appEnvDefaults.ADMIN_BASE_URL;
const adminApiUrl = process.env.ADMIN_API_URL ?? appEnvDefaults.ADMIN_API_URL;
const envFileName = `.playwright-api-${runId.replace(/[^a-zA-Z0-9._-]/g, '-')}.env`;
const envFilePath = path.join(packageDir, envFileName);
const sharedEnv: NodeJS.ProcessEnv = {
  ...appEnvDefaults,
  ...process.env,
  DATABASE_URL: e2eDb.databaseUrl,
  PGBOUNCER_CONNECTION_STRING: e2eDb.databaseUrl,
  BASE_URL: baseUrl,
  API_URL: apiUrl,
  API_PROXY_TARGET: apiUrl,
  ADMIN_BASE_URL: adminBaseUrl,
  ADMIN_API_URL: adminApiUrl,
  ADMIN_API_PROXY_TARGET: adminApiUrl,
  ADMIN_BETTER_AUTH_URL: adminApiUrl,
  ADMIN_PORT: process.env.ADMIN_PORT ?? new URL(adminApiUrl ?? '').port,
  HYDRAHOST_ORGANIZATION_ID: process.env.HYDRAHOST_ORGANIZATION_ID ?? appEnvDefaults.HYDRAHOST_ORGANIZATION_ID,
  VITE_STRICT_PORT: process.env.VITE_STRICT_PORT ?? appEnvDefaults.VITE_STRICT_PORT,
  HUB_PORT: process.env.HUB_PORT ?? new URL(apiUrl ?? '').port,
  PORT: process.env.PORT ?? new URL(baseUrl ?? '').port,
  E2E_RUN_ID: runId,
  DOTENV_CONFIG_PATH: envFilePath,
  DOTENV_CONFIG_OVERRIDE: 'true',
  DISABLE_AUTH_SESSION_CACHE: appEnvDefaults.DISABLE_AUTH_SESSION_CACHE,
  REDIS_URL: appEnvDefaults.REDIS_URL,
};
const envFileContents = [
  `DATABASE_URL=${dotenvQuote(sharedEnv.DATABASE_URL)}`,
  `PGBOUNCER_CONNECTION_STRING=${dotenvQuote(sharedEnv.PGBOUNCER_CONNECTION_STRING)}`,
  `REDIS_URL=${dotenvQuote(sharedEnv.REDIS_URL)}`,
  `BASE_URL=${dotenvQuote(sharedEnv.BASE_URL)}`,
  `API_URL=${dotenvQuote(sharedEnv.API_URL)}`,
  `API_PROXY_TARGET=${dotenvQuote(sharedEnv.API_PROXY_TARGET)}`,
  `ADMIN_BASE_URL=${dotenvQuote(sharedEnv.ADMIN_BASE_URL)}`,
  `ADMIN_API_URL=${dotenvQuote(sharedEnv.ADMIN_API_URL)}`,
  `ADMIN_API_PROXY_TARGET=${dotenvQuote(sharedEnv.ADMIN_API_PROXY_TARGET)}`,
  `ADMIN_BETTER_AUTH_URL=${dotenvQuote(sharedEnv.ADMIN_BETTER_AUTH_URL)}`,
  `ADMIN_PORT=${dotenvQuote(sharedEnv.ADMIN_PORT)}`,
  `HYDRAHOST_ORGANIZATION_ID=${dotenvQuote(sharedEnv.HYDRAHOST_ORGANIZATION_ID)}`,
  `VITE_STRICT_PORT=${dotenvQuote(sharedEnv.VITE_STRICT_PORT)}`,
  `HUB_PORT=${dotenvQuote(sharedEnv.HUB_PORT)}`,
  `PORT=${dotenvQuote(sharedEnv.PORT)}`,
  `HH_ENV=${dotenvQuote(sharedEnv.HH_ENV)}`,
  `IS_LOCAL=${dotenvQuote(sharedEnv.IS_LOCAL)}`,
  `AUTH_BYPASS_ENABLED=${dotenvQuote(sharedEnv.AUTH_BYPASS_ENABLED)}`,
  `AUTH_BYPASS_ALLOWED_ENVS=${dotenvQuote(sharedEnv.AUTH_BYPASS_ALLOWED_ENVS)}`,
  `BROKKR_ADMIN_ORG_ID=${dotenvQuote(sharedEnv.BROKKR_ADMIN_ORG_ID)}`,
  `BROKKR_HUB_PRIVATE_KEY=${dotenvQuote(sharedEnv.BROKKR_HUB_PRIVATE_KEY)}`,
  `S3_ACCESS_KEY_ID=${dotenvQuote(sharedEnv.S3_ACCESS_KEY_ID)}`,
  `S3_BUCKET=${dotenvQuote(sharedEnv.S3_BUCKET)}`,
  `S3_SECRET_ACCESS_KEY=${dotenvQuote(sharedEnv.S3_SECRET_ACCESS_KEY)}`,
  `S3_ENDPOINT_URL=${dotenvQuote(sharedEnv.S3_ENDPOINT_URL)}`,
  `BETTER_AUTH_SECRET=${dotenvQuote(sharedEnv.BETTER_AUTH_SECRET)}`,
  `DEVICE_TOKEN_PEPPER=${dotenvQuote(sharedEnv.DEVICE_TOKEN_PEPPER)}`,
  `DISABLE_WEBHOOK_RETRY_CRON=${dotenvQuote(sharedEnv.DISABLE_WEBHOOK_RETRY_CRON)}`,
  `DISABLE_WEBHOOK_CLEANUP_CRON=${dotenvQuote(sharedEnv.DISABLE_WEBHOOK_CLEANUP_CRON)}`,
  `DISABLE_AUTH_SESSION_CACHE=${dotenvQuote(sharedEnv.DISABLE_AUTH_SESSION_CACHE)}`,
  `SUPPRESS_EXPECTED_AUTH_ERRORS=${dotenvQuote(sharedEnv.SUPPRESS_EXPECTED_AUTH_ERRORS)}`,
].join('\n');
fs.writeFileSync(envFilePath, envFileContents);

cleanupEnvFiles = () => {
  fs.rmSync(envFilePath, { force: true });
};

const generateResult = run('pnpm', ['--filter', '@repo/database', 'db:generate'], {
  cwd: repoRoot,
  env: sharedEnv,
  allowNonZeroExit: true,
});

if (generateResult.status !== 0) {
  console.error('Prisma client generation failed.');
  printPreservedDbInfo();
  cleanupEnvFiles?.();
  process.exit(1);
}

if (process.env.E2E_SKIP_MIGRATE !== 'true') {
  const migrateResult = run('pnpm', ['--filter', '@repo/database', 'db:migrate:deploy'], {
    cwd: repoRoot,
    env: sharedEnv,
    allowNonZeroExit: true,
  });

  if (migrateResult.status !== 0) {
    console.error('Migration failed.');
    printPreservedDbInfo();
    cleanupEnvFiles?.();
    process.exit(1);
  }
}

const buildFilters = ['--filter=api', '--filter=web', '--filter=admin-api', '--filter=admin-web'];
const buildResult = run('pnpm', ['turbo', 'run', 'build', ...buildFilters, '--ui', 'stream'], {
  cwd: repoRoot,
  env: sharedEnv,
  allowNonZeroExit: true,
});

if (buildResult.status !== 0) {
  console.error('Workspace build failed.');
  printPreservedDbInfo();
  cleanupEnvFiles?.();
  process.exit(1);
}

const rawPlaywrightArgs = process.argv.slice(2);
const playwrightArgs = rawPlaywrightArgs[0] === '--' ? rawPlaywrightArgs.slice(1) : rawPlaywrightArgs;
const playwrightResult = run('pnpm', ['exec', 'playwright', 'test', ...playwrightArgs], {
  cwd: packageDir,
  env: sharedEnv,
  capture: true,
  allowNonZeroExit: true,
});

const combinedPlaywrightOutput = `${playwrightResult.stdout ?? ''}\n${playwrightResult.stderr ?? ''}`;
process.stdout.write(combinedPlaywrightOutput);

const unexpectedWebServerErrors = getUnexpectedWebServerErrors(combinedPlaywrightOutput);
const hasUnexpectedErrors = unexpectedWebServerErrors.length > 0;
const testsFailed = playwrightResult.status !== 0;

if (hasUnexpectedErrors) {
  console.error('\nUnexpected backend errors were detected during E2E run:');
  for (const line of unexpectedWebServerErrors) {
    console.error(`- ${line}`);
  }
}

if (testsFailed || hasUnexpectedErrors) {
  printPreservedDbInfo();
  cleanupEnvFiles?.();
  process.exit(testsFailed ? (playwrightResult.status ?? 1) : 1);
}

try {
  await dropE2eDatabase(e2eDb);
  console.log(`Dropped E2E database: ${e2eDb.name}`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Warning: failed to drop E2E database: ${message}`);
  printPreservedDbInfo();
} finally {
  cleanupEnvFiles?.();
}

process.exit(0);
