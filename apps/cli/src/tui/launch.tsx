import chalk from 'chalk';
import { render } from 'ink';
import React from 'react';
import { getActiveEnv, getApiUrl, getEnvApiKey, initConfigIfNeeded } from '../config/env.js';
import { getActiveOrg, getSession } from '../config/store.js';
import { createCliClient } from '../core/client.js';
import { setActiveOrganization } from '../core/organizations.js';
import { getErrorMessage } from '../ui/format.js';
import { App } from './app.js';

export async function launchTui(): Promise<void> {
  initConfigIfNeeded();

  const session = getSession();
  const baseUrl = getApiUrl();

  const apiKey = session?.apiKey ?? getEnvApiKey();

  if (apiKey) {
    const org = getActiveOrg();
    const client = createCliClient(baseUrl, { apiKey });
    render(<App client={client} env={getActiveEnv()} orgName={org?.name ?? 'API Key'} />);
    return;
  }

  if (!session) {
    console.error(`\n  ${chalk.red('Not logged in.')} Run: ${chalk.bold('brokkr login')}\n`);
    process.exit(1);
  }

  const org = getActiveOrg();
  if (!org) {
    console.error(`\n  ${chalk.red('No organization selected.')} Run: ${chalk.bold('brokkr org select')}\n`);
    process.exit(1);
  }

  try {
    await setActiveOrganization(org.id);
  } catch (err) {
    console.error(`\n  ${chalk.red('Could not switch to the active organization.')} ${getErrorMessage(err)}`);
    console.error(`  Try: ${chalk.bold('brokkr org select')} or ${chalk.bold('brokkr login')}\n`);
    process.exit(1);
  }

  const client = createCliClient(baseUrl, { cookie: session.cookie });
  render(<App client={client} env={getActiveEnv()} orgName={org.name} />);
}
