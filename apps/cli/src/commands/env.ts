import chalk from 'chalk';
import { Command } from 'commander';
import { initConfigIfNeeded, listEnvironments, setActiveEnv } from '../config/env.js';
import { dim, fail, getErrorMessage, ok } from '../ui/format.js';

export function registerEnvCommands(program: Command, opts?: { isBridge?: boolean }): void {
  const env = program.command('env', { hidden: opts?.isBridge ?? false }).description('Manage environment profiles');

  env
    .command('list')
    .description('List all environments')
    .action(() => {
      initConfigIfNeeded();
      const envs = listEnvironments();

      console.log('');
      for (const e of envs) {
        const marker = e.active ? chalk.green('▸') : ' ';
        const name = e.active ? chalk.green.bold(e.name) : e.name;
        const detail = e.connectionMode === 'bridge' ? dim('(bridge)') : dim(e.apiUrl);
        console.log(`  ${marker} ${name}  ${detail}`);
      }
      console.log('');
    });

  env
    .command('use <name>')
    .description('Switch active environment')
    .action((name: string) => {
      initConfigIfNeeded();
      try {
        setActiveEnv(name);
        const envs = listEnvironments();
        const active = envs.find((e) => e.active);
        ok(`Switched to ${chalk.bold(name)} ${dim(`(${active?.apiUrl})`)}`);
      } catch (err) {
        fail(getErrorMessage(err));
      }
    });
}
