import { Command } from 'commander';
import { registerBridgesCommand } from './bridges.js';
import { registerDatacentersCommand } from './datacenters.js';
import { registerDecommissionCommand } from './decommission.js';
import { registerListingCommand } from './listing.js';
import { registerProvisionCommand } from './provision.js';
import { registerDecommissionedServersCommand, registerServersCommand } from './servers.js';
import { registerSettingsCommand } from './settings.js';

export function registerDcimCommands(program: Command): void {
  const dcim = program.command('dcim').description('Data center infrastructure management');

  registerDatacentersCommand(dcim);
  registerBridgesCommand(dcim);
  registerServersCommand(dcim);
  registerDecommissionedServersCommand(dcim);

  registerDecommissionCommand(dcim);
  registerSettingsCommand(dcim);
  registerListingCommand(dcim);
  registerProvisionCommand(dcim);
}
