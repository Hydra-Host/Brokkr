import { Command } from 'commander';
import { registerCreateProjectCommand } from './create-project.js';
import { registerDeleteProjectCommand } from './delete-project.js';
import { registerDeploymentsCommand } from './deployments.js';
import { registerDeprovisionCommand } from './deprovision.js';
import { registerLockCommand } from './lock.js';
import { registerPowerCommand } from './power.js';
import { registerProjectsCommand } from './projects.js';
import { registerRenameCommand } from './rename.js';
import { registerReprovisionCommand } from './reprovision.js';
import { registerRescueCommand } from './rescue.js';

export function registerDeploymentCommands(program: Command): void {
  registerDeploymentsCommand(program);
  registerProjectsCommand(program);

  registerRenameCommand(program);
  registerPowerCommand(program);
  registerRescueCommand(program);
  registerLockCommand(program);
  registerDeprovisionCommand(program);
  registerReprovisionCommand(program);
  registerDeleteProjectCommand(program);
  registerCreateProjectCommand(program);
}
