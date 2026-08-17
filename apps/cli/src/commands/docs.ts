import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, getErrorMessage } from '../ui/format.js';

declare const BROWSER_DOCS_CONTENT: string | undefined;

export function registerDocsCommand(program: Command): void {
  program
    .command('docs')
    .description('Print full CLI reference (for LLM and scripting usage)')
    .action(() => {
      if (typeof BROWSER_DOCS_CONTENT !== 'undefined') {
        console.log(BROWSER_DOCS_CONTENT);
        return;
      }
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const mdPath = join(__dirname, '..', '..', 'LLM_CLI_REFERENCE.md');
      try {
        console.log(readFileSync(mdPath, 'utf-8'));
      } catch (err) {
        fail(`Could not read CLI reference at ${mdPath}: ${getErrorMessage(err)}`);
      }
    });
}
