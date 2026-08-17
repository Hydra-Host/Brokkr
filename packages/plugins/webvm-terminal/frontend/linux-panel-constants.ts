// Private constants for the useLinuxVM hook (its sole importer): the bash
// scripts written into the VM's DataDevice and the terminal's UI text/steps.
import type { LoadingStep } from './linux-panel-types';

// The `brokkr` wrapper emits a null-delimited BROKKR_CMD marker on stdout that
// the browser intercepts to run the full CLI via runBrokkrCommand().
export const BROKKR_SCRIPT = `#!/bin/bash
# Send the args to the browser as a BROKKR_CMD marker. Each argument is
# base64-encoded: the base64 alphabet needs no JSON escaping, so quotes,
# backslashes, newlines, and other control characters survive intact (a
# hand-rolled quote/backslash sed escape would corrupt the JSON on any of them).
ARGS_JSON="["
FIRST=true
for arg in "$@"; do
  encoded=$(printf '%s' "$arg" | base64 | tr -d '\\n')
  if [ "$FIRST" = true ]; then
    ARGS_JSON="\${ARGS_JSON}\\"$encoded\\""
    FIRST=false
  else
    ARGS_JSON="\${ARGS_JSON},\\"$encoded\\""
  fi
done
ARGS_JSON="\${ARGS_JSON}]"
printf '\\0BROKKR_CMD:{"args64":%s}\\0' "$ARGS_JSON"
`;

export const BROKKR_BASHRC = `export PS1='\\[\\e[32m\\]user\\[\\e[0m\\]@\\[\\e[34m\\]webvm\\[\\e[0m\\]:\\[\\e[33m\\]\\w\\[\\e[0m\\]\\$ '
export BROKKR_BRIDGE=1

# DataDevice files aren't executable — wrap as a function
brokkr() {
  bash /brokkr/brokkr "$@"
}
export -f brokkr

export HISTFILE=/home/user/.bash_history
# Seed history once so the up-arrow suggests the CLI on first launch. Guarded:
# the IDB overlay persists the home dir across sessions, so an unconditional
# append would stack a duplicate entry on every login.
[ -f "$HISTFILE" ] || echo "brokkr" > "$HISTFILE"

if [ -z "$BROKKR_WELCOMED" ]; then
  export BROKKR_WELCOMED=1
  echo ""
  echo "  CLI is ready. Type 'brokkr --help' for commands."
  echo ""
fi
`;

export const TERMINAL_BANNER = [
  '\x1b[33m+------------------------------------------+\x1b[0m',
  '\x1b[33m|              Linux Terminal              |\x1b[0m',
  '\x1b[33m+------------------------------------------+\x1b[0m',
  '',
  'Starting Debian Linux...\n',
];

export const SPINNER_VERBS = [
  'Tinkering',
  'Newspapering',
  'Doodling',
  'Rummaging',
  'Pondering',
  'Scribbling',
  'Juggling',
  'Spelunking',
  'Wrangling',
  'Percolating',
  'Snooping',
  'Concocting',
  'Marinating',
  'Fumbling',
  'Daydreaming',
];

export function randomSpinnerVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
}

export const INITIAL_LOADING_STEPS: LoadingStep[] = [
  { id: 'script', label: 'Loading CheerpX runtime', status: 'pending' },
  { id: 'xterm', label: 'Initializing terminal', status: 'pending' },
  { id: 'devices', label: 'Setting up disk image', status: 'pending' },
  { id: 'vm', label: 'Starting Linux kernel', status: 'pending' },
  { id: 'shell', label: 'Launching shell', status: 'pending' },
];
