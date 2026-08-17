// Kept out of ./index.ts so the main app bundle never pulls the terminal
// engine — only the cross-origin-isolated popup document imports this subpath.
export { TerminalWindow } from './terminal-window';
export type { BrokkrCommandHandle, BrokkrCommandHandler } from './use-linux-vm';
