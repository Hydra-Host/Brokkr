import { Command } from 'commander';
import { registerInventoryCommand } from './list.js';
import { registerInventoryRentCommand } from './rent.js';

export function registerInventoryCommands(program: Command): void {
  registerInventoryCommand(program);
  registerInventoryRentCommand(program);
}
