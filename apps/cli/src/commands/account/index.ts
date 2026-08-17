import { Command } from 'commander';
import { registerAccountProfileCommands } from './profile.js';
import { registerAccountSshKeysCommands } from './ssh-keys.js';

export function registerAccountCommands(program: Command): void {
  const account = program.command('account').description('User account management');
  registerAccountProfileCommands(account);
  registerAccountSshKeysCommands(account);
}
