import chalk from 'chalk';
import type { Command } from 'commander';
import {
  detectShell,
  installCompletion,
  isShell,
  rcPath,
  uninstallCompletion,
  type Shell,
} from '../completion/install.js';
import { BASH_SCRIPT } from '../completion/scripts/bash.js';
import { FISH_SCRIPT } from '../completion/scripts/fish.js';
import { ZSH_SCRIPT } from '../completion/scripts/zsh.js';
import { walkTree } from '../completion/walk.js';
import { fail, ok } from '../ui/format.js';

const SHELL_SCRIPTS: Record<Shell, string> = {
  bash: BASH_SCRIPT,
  zsh: ZSH_SCRIPT,
  fish: FISH_SCRIPT,
};

function resolveShell(arg: string | undefined): Shell {
  if (arg !== undefined) {
    if (!isShell(arg)) fail(`Unsupported shell "${arg}". Supported: bash, zsh, fish`);
    return arg;
  }
  const detected = detectShell();
  if (!detected) {
    fail(
      'Could not detect your shell from $SHELL. Run with an explicit shell: `brokkr completion install <bash|zsh|fish>`',
    );
  }
  return detected;
}

export function registerCompletionCommands(program: Command): void {
  const completion = program.command('completion').description('Shell tab completion');

  completion
    .command('install [shell]')
    .description('Install shell tab completion (auto-detects shell from $SHELL if omitted)')
    .addHelpText(
      'after',
      `
What this does:
  zsh / bash   Appends an 'eval "$(brokkr completion script <shell>)"' block to
               ~/.zshrc or ~/.bashrc (idempotent — safe to run twice).
  fish         Writes ~/.config/fish/completions/brokkr.fish (auto-loaded by fish).

Restart your shell (or 'source' the rc file) to activate.
Remove at any time with: brokkr completion uninstall`,
    )
    .action((shellArg: string | undefined) => {
      const shell = resolveShell(shellArg);
      const result = installCompletion(shell);
      const subject = shell === 'fish' ? 'fish' : 'your shell';
      if (result.action === 'already-installed') {
        ok(`Completion already installed for ${chalk.bold(shell)} at ${result.path}`);
        return;
      }
      ok(`Installed ${chalk.bold(shell)} completion to ${result.path}`);
      ok(`Restart ${subject} (or run: ${chalk.cyan('source ' + result.path)}) to activate.`);
    });

  completion
    .command('uninstall [shell]')
    .description('Remove shell tab completion')
    .action((shellArg: string | undefined) => {
      const shell = resolveShell(shellArg);
      const result = uninstallCompletion(shell);
      if (result.action === 'not-found') {
        ok(`No completion install found for ${chalk.bold(shell)} at ${rcPath(shell)}`);
        return;
      }
      ok(`Removed ${chalk.bold(shell)} completion from ${result.path}`);
    });

  completion
    .command('script <shell>')
    .description('Print the raw completion script to stdout (for manual installation)')
    .action((shell: string) => {
      if (!isShell(shell)) fail(`Unsupported shell "${shell}". Supported: bash, zsh, fish`);
      process.stdout.write(SHELL_SCRIPTS[shell]);
    });

  program
    .command('__complete', { hidden: true })
    .allowUnknownOption(true)
    .description('Internal: print completion candidates for the given words')
    .argument('[words...]', 'Command words typed so far, including a trailing partial')
    .action((words: string[] = []) => {
      for (const candidate of walkTree(program, words)) {
        process.stdout.write(candidate + '\n');
      }
    });
}
