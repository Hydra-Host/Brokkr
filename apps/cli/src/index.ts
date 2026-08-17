#!/usr/bin/env node

const args = process.argv.slice(2);
const shouldLaunchTui = args.length === 0 || (args.length === 1 && args[0] === 'tui');

if (shouldLaunchTui) {
  const { launchTui } = await import('./tui/launch.js');
  await launchTui();
} else {
  const { createProgram } = await import('./program.js');
  const program = createProgram();
  const { loadAdminCommands } = await import('./admin/load-admin.js');
  await loadAdminCommands(program);
  program.parse();
}
