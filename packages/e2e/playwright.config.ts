import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '../..');
const baseUrl = process.env.BASE_URL ?? 'http://localhost:5173';
const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
const basePort = Number(new URL(baseUrl).port);
const apiPort = Number(new URL(apiUrl).port);
const adminBaseUrl = process.env.ADMIN_BASE_URL ?? 'http://localhost:5177';
const adminApiUrl = process.env.ADMIN_API_URL ?? 'http://localhost:3211';
const adminBasePort = Number(new URL(adminBaseUrl).port);
const adminApiPort = Number(new URL(adminApiUrl).port);
const definedEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
};
const webServerEnv = definedEnv({
  ...process.env,
  API_PROXY_TARGET: apiUrl,
  ADMIN_API_PROXY_TARGET: adminApiUrl,
  ADMIN_PORT: String(adminApiPort),
  ADMIN_BASE_URL: adminBaseUrl,
  ADMIN_BETTER_AUTH_URL: adminApiUrl,
  VITE_LOCAL_SIMULATION_ENABLED: 'true',
  NODE_OPTIONS: [process.env.NODE_OPTIONS, '--experimental-strip-types'].filter(Boolean).join(' '),
  DISABLE_WEBHOOK_RETRY_CRON: 'true',
  DISABLE_WEBHOOK_CLEANUP_CRON: 'true',
  DISABLE_AUTH_SESSION_CACHE: 'true',
  SUPPRESS_EXPECTED_AUTH_ERRORS: 'true',
});
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const envPrefix = (...keys: string[]): string =>
  keys.map((key) => `${key}=${shellQuote(webServerEnv[key] ?? '')}`).join(' ');
const apiEnvPrefix = envPrefix(
  'DATABASE_URL',
  'PGBOUNCER_CONNECTION_STRING',
  'REDIS_URL',
  'BASE_URL',
  'API_URL',
  'API_PROXY_TARGET',
  'HUB_PORT',
  'HH_ENV',
  'IS_LOCAL',
  'AUTH_BYPASS_ENABLED',
  'AUTH_BYPASS_ALLOWED_ENVS',
  'BROKKR_ADMIN_ORG_ID',
  'BROKKR_HUB_PRIVATE_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_BUCKET',
  'S3_SECRET_ACCESS_KEY',
  'S3_ENDPOINT_URL',
  'BETTER_AUTH_SECRET',
  'DEVICE_TOKEN_PEPPER',
  'DOTENV_CONFIG_PATH',
  'DOTENV_CONFIG_OVERRIDE',
  'DISABLE_WEBHOOK_RETRY_CRON',
  'DISABLE_WEBHOOK_CLEANUP_CRON',
  'DISABLE_AUTH_SESSION_CACHE',
  'SUPPRESS_EXPECTED_AUTH_ERRORS',
);
const webEnvPrefix = envPrefix('API_PROXY_TARGET', 'BASE_URL', 'API_URL', 'PORT', 'VITE_STRICT_PORT');
const adminApiEnvPrefix = envPrefix(
  'DATABASE_URL',
  'PGBOUNCER_CONNECTION_STRING',
  'REDIS_URL',
  'ADMIN_PORT',
  'ADMIN_BASE_URL',
  'ADMIN_BETTER_AUTH_URL',
  'HYDRAHOST_ORGANIZATION_ID',
  'BROKKR_ADMIN_ORG_ID',
  'HH_ENV',
  'IS_LOCAL',
  'AUTH_BYPASS_ENABLED',
  'AUTH_BYPASS_ALLOWED_ENVS',
  'BETTER_AUTH_SECRET',
  'DEVICE_TOKEN_PEPPER',
  'DOTENV_CONFIG_PATH',
  'DOTENV_CONFIG_OVERRIDE',
);
const adminWebEnvPrefix = `${envPrefix('ADMIN_API_PROXY_TARGET', 'VITE_LOCAL_SIMULATION_ENABLED')} PORT=${shellQuote(String(adminBasePort))}`;

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? 2),
  use: {
    headless: true,
    baseURL: baseUrl,
    actionTimeout: 30_000,
    screenshot: 'on',
  },
  expect: {
    timeout: 60_000,
  },
  reporter: process.env.CI ? [['html'], ['junit', { outputFile: 'results.xml' }]] : [['html']],
  projects: [
    {
      name: 'main-app',
      testIgnore: /specs\/admin\//,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'admin-panel',
      testMatch: /specs\/admin\/.*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: adminBaseUrl },
    },
  ],
  webServer: [
    {
      command: `${apiEnvPrefix} pnpm start`,
      cwd: path.resolve(monorepoRoot, 'apps/api'),
      env: webServerEnv,
      port: apiPort,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `${webEnvPrefix} pnpm dev`,
      cwd: path.resolve(monorepoRoot, 'apps/web'),
      env: webServerEnv,
      port: basePort,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `${adminApiEnvPrefix} pnpm start`,
      cwd: path.resolve(monorepoRoot, 'apps/admin-api'),
      env: webServerEnv,
      port: adminApiPort,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `${adminWebEnvPrefix} pnpm dev`,
      cwd: path.resolve(monorepoRoot, 'apps/admin-web'),
      env: webServerEnv,
      port: adminBasePort,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
