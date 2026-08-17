import type { Command } from 'commander';

const ADMIN_MODULE = '@hydrahost/admin-cli';
const MODULE_ABSENT_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
// Anchored on the missing specifier: when admin-cli is installed under node_modules, a transitive
// miss's "imported from .../node_modules/@hydrahost/admin-cli/..." path would satisfy a bare
// includes(ADMIN_MODULE) and wrongly silence real breakage.
const ADMIN_MODULE_ABSENT_RE = /Cannot find (?:package|module) ['"`]@hydrahost\/admin-cli['"`]/;

interface AdminCliModule {
  registerAdminCommands?: (program: Command) => void;
}

export async function loadAdminCommands(program: Command): Promise<void> {
  if (process.env.BROKKR_NO_ADMIN === '1') return;
  try {
    // sync-sentinel: dynamic import — absence must be a caught runtime miss. Do not statically import.
    const mod: AdminCliModule = await import(ADMIN_MODULE);
    mod.registerAdminCommands?.(program);
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : '';
    const message = err instanceof Error ? err.message : String(err);
    // Silent omission ONLY when the admin package itself is absent (public BOSS edition).
    // A module-not-found for a transitive dep (e.g. an unbuilt admin-api-client dist) is real breakage — surface it.
    if (MODULE_ABSENT_CODES.has(code) && ADMIN_MODULE_ABSENT_RE.test(message)) return;
    // Diagnostic on stderr, never stdout: this runs for every non-TUI command, and warn() (stdout) would
    // prepend text to a command's --json output.
    const { getErrorMessage } = await import('../ui/format.js');
    process.stderr.write(`admin commands present but failed to load: ${getErrorMessage(err)}\n`);
  }
}
