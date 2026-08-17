import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import {
  clearEnvApiKey,
  getActiveEnv,
  getApiUrl,
  getConnectionMode,
  getEnvApiKey,
  getProcessApiKey,
  initConfigIfNeeded,
} from '../config/env.js';
import { clearSession, getActiveOrg, getSession, saveActiveOrg, saveSession } from '../config/store.js';
import type { LoginResult } from '../core/auth.js';
import {
  getSession as fetchSession,
  isTwoFactorRequired,
  login,
  logout,
  verifyApiKey,
  verifyTotp,
} from '../core/auth.js';
import { listOrganizations, setActiveOrganization } from '../core/organizations.js';
import { dim, fail, formatTenantType, getErrorMessage, info, ok, warn } from '../ui/format.js';
import { prompt } from '../ui/prompt.js';
import { renderJson, withSpinner } from '../ui/table.js';

async function promptCredentials(): Promise<{ email: string; password: string }> {
  const email = prompt(
    await p.text({
      message: 'Email',
      placeholder: 'you@example.com',
      validate: (v) => {
        if (!v.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) return 'A valid email is required';
      },
    }),
  );
  const password = prompt(await p.password({ message: 'Password' }));
  return { email, password };
}

async function authenticate(baseUrl: string): Promise<LoginResult> {
  const { email, password } = await promptCredentials();
  const result = await login(baseUrl, email, password);

  if (!isTwoFactorRequired(result)) return result;

  const code = prompt(
    await p.text({
      message: '2FA code',
      placeholder: '123456',
      validate: (v) => {
        if (!/^\d{6}$/.test(v)) return '6 digits required';
      },
    }),
  );

  return verifyTotp(baseUrl, code, result.cookie);
}

type ApiKeyResolution =
  | { source: 'argv'; key: string; warnArgvExposure: true }
  | { source: 'env'; key: string }
  | { source: 'prompt' };

export function resolveApiKeySource(flagValue: string | boolean | undefined, envApiKey?: string): ApiKeyResolution {
  if (typeof flagValue === 'string') return { source: 'argv', key: flagValue, warnArgvExposure: true };
  const env = envApiKey?.trim();
  if (env) return { source: 'env', key: env };
  return { source: 'prompt' };
}

async function pickOrganization(): Promise<void> {
  let orgs;
  try {
    orgs = await withSpinner('Fetching organizations...', () => listOrganizations(), {
      quietFail: true,
      onError: (err) => {
        throw err;
      },
    });
  } catch {
    warn('Could not fetch organizations. Run: brokkr org select');
    return;
  }

  if (orgs.length === 0) return;

  let selected;
  if (orgs.length === 1) {
    selected = orgs[0]!;
  } else {
    const choice = prompt(
      await p.select({
        message: 'Select organization',
        options: orgs.map((o) => ({
          value: o.id,
          label: o.name,
          hint: `${o.role} · ${formatTenantType(o.tenantType)}`,
        })),
      }),
    );
    selected = orgs.find((o) => o.id === choice)!;
  }

  try {
    await setActiveOrganization(selected.id);
  } catch (err) {
    warn(
      `Could not set active organization: ${getErrorMessage(err)}. Run ${chalk.bold('brokkr org select')} to try again.`,
    );
    return;
  }

  saveActiveOrg({ id: selected.id, name: selected.name, tenantType: selected.tenantType, role: selected.role });
  ok(`Organization: ${chalk.bold(selected.name)}`);
}

export function registerAuthCommands(program: Command, opts?: { isBridge?: boolean }): void {
  const isBridge = opts?.isBridge ?? false;

  program
    .command('login', { hidden: isBridge })
    .description('Authenticate with your Brokkr account')
    .option(
      '-k, --api-key [key]',
      'Log in with an API key instead of email/password. For scripting, prefer the BROKKR_API_KEY env var over passing the key inline (an inline key leaks into shell history and process listings).',
    )
    .action(async (flags: { apiKey?: string | boolean }) => {
      initConfigIfNeeded();

      if (getConnectionMode() === 'bridge') {
        ok('Authentication is handled by your browser session. You are already logged in.');
        return;
      }

      const baseUrl = getApiUrl();

      const resolution = resolveApiKeySource(flags.apiKey, process.env.BROKKR_API_KEY);

      if (flags.apiKey !== undefined || resolution.source === 'env') {
        p.intro(chalk.bold('Brokkr Login — API Key') + dim(` (${getActiveEnv()})`));

        let key: string;
        if (resolution.source === 'argv') {
          warn(
            'Passing --api-key on the command line exposes the secret via shell history and process listings (ps). Prefer the BROKKR_API_KEY env var or the interactive prompt.',
          );
          key = resolution.key;
        } else if (resolution.source === 'env') {
          key = resolution.key;
        } else {
          key = prompt(
            await p.password({
              message: 'API Key',
              validate: (v) => {
                if (!v.trim()) return 'API key is required';
              },
            }),
          );
        }

        const org = await withSpinner('Verifying API key...', () => verifyApiKey(baseUrl, key));
        saveSession({ cookie: '', apiKey: key, email: '(api-key)', userId: '' });
        saveActiveOrg({ id: org.organizationId, name: org.organizationName, tenantType: org.tenantType });
        ok('Authenticated via API key');
        ok(`Organization: ${chalk.bold(org.organizationName)}`);
        return;
      }

      p.intro(chalk.bold('Brokkr Login') + dim(` (${getActiveEnv()})`));

      try {
        const result = await authenticate(baseUrl);
        saveSession({ cookie: result.cookie, email: result.email, userId: result.userId });
        ok(`Logged in as ${chalk.bold(result.email)}`);
        await pickOrganization();
      } catch (err) {
        fail(getErrorMessage(err));
      }
    });

  program
    .command('logout', { hidden: isBridge })
    .description('Clear your session')
    .action(async () => {
      initConfigIfNeeded();

      if (getConnectionMode() === 'bridge') {
        ok('Use the browser to log out. Session is managed by the browser.');
        return;
      }

      const session = getSession();
      if (session) {
        try {
          await logout(getApiUrl(), session.cookie);
        } catch (error) {
          warn(`Could not log out on the server: ${getErrorMessage(error)}`);
        }
      }
      clearSession();
      // Purge the env-key auth fallback too — a logged-out user must not auth via a stale config.json apiKey.
      clearEnvApiKey();
      ok('Logged out');
    });

  program
    .command('whoami')
    .description('Show current user, organization, and environment')
    .option('--json', 'Output as JSON', false)
    .action(async (flags: { json: boolean }) => {
      initConfigIfNeeded();
      const env = getActiveEnv();
      const mode = getConnectionMode();

      if (mode === 'bridge') {
        const { getAuthenticatedClient } = await import('../core/client.js');
        const client = getAuthenticatedClient();
        const result = await withSpinner('Checking session...', () => client.getMe(), {
          onError: () => fail('Could not reach the browser bridge'),
        });
        if (result.status === 200) {
          const user = result.body;
          if (flags.json) {
            renderJson({ email: user.email, environment: env, mode: 'bridge' });
            return;
          }
          console.log('');
          info('User        ', chalk.bold(user.email));
          info('Environment ', `${chalk.bold(env)} ${dim('(bridge)')}`);
          console.log('');
        } else {
          fail('Could not fetch user info via bridge');
        }
        return;
      }

      const baseUrl = getApiUrl();
      const session = getSession();

      const apiKey = getProcessApiKey() ?? session?.apiKey ?? getEnvApiKey();

      if (!session && !apiKey) fail(`Not logged in. Run: ${chalk.bold('brokkr login')}`);

      if (apiKey) {
        const org = await withSpinner('Checking API key...', () => verifyApiKey(baseUrl, apiKey), {
          onError: () => {
            clearSession();
            fail(`API key invalid or expired. Run: ${chalk.bold('brokkr login --api-key')}`);
          },
        });

        if (flags.json) {
          renderJson({
            authMethod: 'api-key',
            organization: {
              id: org.organizationId,
              name: org.organizationName,
              tenantType: org.tenantType,
            },
            environment: env,
            apiUrl: baseUrl,
          });
          return;
        }

        console.log('');
        info('Auth        ', chalk.bold('API Key'));
        info('Organization', `${chalk.bold(org.organizationName)} ${dim(`[${org.tenantType}]`)}`);
        info('Environment ', `${chalk.bold(env)} ${dim(`(${baseUrl})`)}`);
        console.log('');
        return;
      }

      if (!session) fail(`Not logged in. Run: ${chalk.bold('brokkr login')}`);

      const user = await withSpinner('Checking session...', () => fetchSession(baseUrl, session.cookie), {
        onError: () => {
          clearSession();
          fail(`Session expired. Run: ${chalk.bold('brokkr login')}`);
        },
      });

      const org = getActiveOrg();

      if (flags.json) {
        renderJson({
          email: user.email,
          name: user.name ?? null,
          organization: org ? { id: org.id, name: org.name, tenantType: org.tenantType, role: org.role ?? null } : null,
          environment: env,
          apiUrl: baseUrl,
        });
        return;
      }

      const orgLabel = org
        ? `${chalk.bold(org.name)} ${dim(`[${org.tenantType}]`)}`
        : chalk.yellow('None') + ` — run ${chalk.bold('brokkr org select')}`;

      console.log('');
      info('User        ', `${chalk.bold(user.email)}${user.name ? dim(` (${user.name})`) : ''}`);
      info('Organization', orgLabel);
      info('Environment ', `${chalk.bold(env)} ${dim(`(${baseUrl})`)}`);
      console.log('');
    });
}
