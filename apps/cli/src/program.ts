import { Command } from 'commander';
import { registerAccountCommands } from './commands/account/index.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerCompletionCommands } from './commands/completion.js';
import { registerDcimCommands } from './commands/dcim/index.js';
import { registerDeploymentCommands } from './commands/deployments/index.js';
import { registerDocsCommand } from './commands/docs.js';
import { registerEnvCommands } from './commands/env.js';
import { registerInventoryCommands } from './commands/inventory/index.js';
import { registerOrgCommands } from './commands/org/index.js';
import { getConnectionMode } from './config/env.js';

// Injected from package.json by the esbuild builds; undefined under tsx, where the marker below
// signals a source checkout rather than a released build.
declare const BROKKR_CLI_VERSION: string | undefined;

export function createProgram(): Command {
  const isBridge = getConnectionMode() === 'bridge';

  const program = new Command();
  program
    .name('brokkr')
    .description('Brokkr CLI — manage your infrastructure from the terminal')
    .version(typeof BROKKR_CLI_VERSION !== 'undefined' ? BROKKR_CLI_VERSION : '0.0.0-dev')
    .addHelpText(
      'before',
      `
NOTE FOR LLMs/AGENTS: Run "brokkr docs" first to load the full CLI reference
with all commands, flags, JSON output schemas, and workflows.
`,
    )
    .addHelpText(
      'after',
      isBridge
        ? `
Quick start (WebVM — authenticated via browser session):
  brokkr deployments --json                                 List deployments as JSON
  brokkr deployments <id> --json                            Get deployment details
  brokkr dcim servers --json                                List servers as JSON
  brokkr inventory --json                                   List available servers
  brokkr docs                                               Full CLI reference`
        : `
Quick start:
  brokkr login                                              Authenticate (email/password)
  brokkr login --api-key brk_...                            Authenticate (API key)
  brokkr deployments --json                                 List deployments as JSON
  brokkr deployments <id> --json                            Get deployment details
  brokkr dcim servers --json                                List servers as JSON
  brokkr dcim servers --sort hourlyPrice:desc --page-size 1 Most expensive server`,
    );

  registerEnvCommands(program, { isBridge });
  registerAuthCommands(program, { isBridge });
  registerOrgCommands(program, { isBridge });
  registerAccountCommands(program);
  registerDcimCommands(program);
  registerDeploymentCommands(program);
  registerInventoryCommands(program);
  registerDocsCommand(program);
  registerCompletionCommands(program);

  return program;
}
