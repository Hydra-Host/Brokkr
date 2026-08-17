#!/usr/bin/env node
// Bails silently on any failure — postinstall must never fail the npm install.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skip = (reason) => {
  console.log(`brokkr: skipping tab-completion auto-install (${reason}).`);
  console.log('        run `brokkr completion install` any time to enable.');
  process.exit(0);
};

if (process.env.CI) skip('CI environment detected');
if (process.env.BROKKR_SKIP_POSTINSTALL) skip('BROKKR_SKIP_POSTINSTALL is set');
if (process.env.npm_config_ignore_scripts === 'true') process.exit(0);

const home = process.env.HOME;
if (!home || home === '/root' || home.startsWith('/var/root')) {
  skip(`HOME="${home ?? 'unset'}" — likely a root/system install`);
}
if (!process.env.SHELL) skip('$SHELL is not set');

const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
const result = spawnSync(process.execPath, [cliPath, 'completion', 'install'], {
  stdio: 'inherit',
});
if (result.status !== 0) {
  console.log('brokkr: completion auto-install did not complete cleanly. Run `brokkr completion install` to retry.');
}
process.exit(0);
