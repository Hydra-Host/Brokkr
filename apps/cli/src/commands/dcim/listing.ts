import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { updateServerListing } from '../../core/dcim/mutations.js';
import { getServer } from '../../core/dcim/servers.js';
import { fail, info, ok, parseToggle } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';
import { resolveServerId } from './select-server.js';

function centsToDollars(cents: number | null): string | null {
  if (cents == null) return null;
  return (cents / 100).toFixed(2);
}

function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function registerListingCommand(parent: Command): void {
  parent
    .command('servers:listing')
    .description('Update server marketplace listing and pricing')
    .argument('[id]', 'Device ID')
    .option('--hourly-price <price>', 'On-demand hourly price in USD (e.g. 4.50)')
    .option('--floor-price <price>', 'Floor (minimum interruptible) hourly price in USD (e.g. 2.50)')
    .option('--listed <value>', 'List in Brokkr Inventory: on or off')
    .option('--interruptible-only <value>', 'List as interruptible only: on or off')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Modify the public listing of your server on Brokkr. Controls marketplace
visibility, on-demand pricing, and floor (interruptible) pricing.

Price values are in USD per hour (e.g. 4.50 for $4.50/hr).

Examples:
  brokkr dcim servers:listing                                            Interactive mode
  brokkr dcim servers:listing <id> --hourly-price 4.50 --listed on       Set price and list
  brokkr dcim servers:listing <id> --hourly-price 4.50 --floor-price 2.50 --listed on --interruptible-only off
  brokkr dcim servers:listing <id> --listed off                          Delist server
  brokkr dcim servers:listing <id> --hourly-price 5.00 --json            JSON output`,
    )
    .action(
      async (
        idArg: string | undefined,
        flags: {
          hourlyPrice?: string;
          floorPrice?: string;
          listed?: string;
          interruptibleOnly?: string;
          json: boolean;
        },
      ) => {
        const client = getAuthenticatedClient();
        const id = await resolveServerId(client, idArg);

        const server = await withSpinner('Fetching server...', () => getServer(client, id));

        const currentHourlyDollars = centsToDollars(server.listing.onDemandPricePerHourCents);
        const currentFloorDollars = centsToDollars(server.listing.interruptiblePricePerHourCents);

        let hourlyPriceDollars: number | undefined;
        let floorPriceDollars: number | undefined;
        let isListed: boolean | undefined;
        let isInterruptibleOnly: boolean | undefined;

        if (flags.hourlyPrice !== undefined) {
          hourlyPriceDollars = parseFloat(flags.hourlyPrice);
          if (isNaN(hourlyPriceDollars) || hourlyPriceDollars <= 0) {
            fail('Hourly price must be a number greater than 0');
          }
        }
        if (flags.floorPrice !== undefined) {
          floorPriceDollars = parseFloat(flags.floorPrice);
          if (isNaN(floorPriceDollars) || floorPriceDollars <= 0) {
            fail('Floor price must be a number greater than 0');
          }
        }
        if (flags.listed !== undefined) {
          isListed = parseToggle(flags.listed, '--listed');
        }
        if (flags.interruptibleOnly !== undefined) {
          isInterruptibleOnly = parseToggle(flags.interruptibleOnly, '--interruptible-only');
        }

        const needsPrompts =
          hourlyPriceDollars === undefined &&
          floorPriceDollars === undefined &&
          isListed === undefined &&
          isInterruptibleOnly === undefined;

        if (needsPrompts) {
          p.intro(chalk.bold('Server Listing'));

          info('Device', server.displayName);
          info('Current Hourly Price', currentHourlyDollars ? `$${currentHourlyDollars}/hr` : 'Not set');
          info('Current Floor Price', currentFloorDollars ? `$${currentFloorDollars}/hr` : 'Not set');
          info('Currently Listed', server.listing.isActive ? 'Yes' : 'No');
          info('Interruptible Only', server.listing.isInterruptibleOnly ? 'Yes' : 'No');

          const hourlyStr = prompt(
            await p.text({
              message: 'Hourly price (USD)',
              initialValue: currentHourlyDollars ?? '',
              placeholder: 'e.g. 4.50',
              validate: (v) => {
                const n = parseFloat(v);
                if (isNaN(n) || n <= 0) return 'Price must be greater than 0';
              },
            }),
          );
          hourlyPriceDollars = parseFloat(hourlyStr);

          const floorStr = prompt(
            await p.text({
              message: 'Floor hourly price (USD)',
              initialValue: currentFloorDollars ?? '',
              placeholder: 'e.g. 2.50',
              validate: (v) => {
                const n = parseFloat(v);
                if (isNaN(n) || n <= 0) return 'Floor price must be greater than 0';
                if (hourlyPriceDollars !== undefined && n > hourlyPriceDollars) {
                  return 'Floor price cannot exceed hourly price';
                }
              },
            }),
          );
          floorPriceDollars = parseFloat(floorStr);

          const listedValue = prompt(
            await p.select({
              message: 'List in Brokkr Inventory',
              options: [
                { value: true as const, label: 'Yes', hint: 'Visible on the marketplace' },
                { value: false as const, label: 'No', hint: 'Hidden from the marketplace' },
              ],
              initialValue: server.listing.isActive ?? false,
            }),
          );
          isListed = listedValue;

          const interruptibleValue = prompt(
            await p.select({
              message: 'List as Interruptible Only',
              options: [
                { value: true as const, label: 'Yes', hint: 'Only accept interruptible reservations' },
                { value: false as const, label: 'No', hint: 'Accept all reservation types' },
              ],
              initialValue: server.listing.isInterruptibleOnly ?? false,
            }),
          );
          isInterruptibleOnly = interruptibleValue;
        }

        const currentHourlyCents = server.listing.onDemandPricePerHourCents;
        const currentFloorCents = server.listing.interruptiblePricePerHourCents;

        const resolvedHourlyDollars =
          hourlyPriceDollars ?? (currentHourlyCents != null ? currentHourlyCents / 100 : undefined);
        const resolvedFloorDollars =
          floorPriceDollars ?? (currentFloorCents != null ? currentFloorCents / 100 : undefined);

        if (resolvedHourlyDollars == null) {
          fail('Server has no hourly price set. Provide --hourly-price');
        }

        if (resolvedFloorDollars != null && resolvedFloorDollars > resolvedHourlyDollars) {
          fail('Floor price cannot be greater than hourly price');
        }

        const body = {
          hourlyPrice: dollarsToCents(resolvedHourlyDollars),
          ...(resolvedFloorDollars != null ? { floorHourlyPrice: dollarsToCents(resolvedFloorDollars) } : {}),
          billingFrequency: 'Weekly' as const,
          isListed: isListed ?? server.listing.isActive ?? false,
          isInterruptibleOnly: isInterruptibleOnly ?? server.listing.isInterruptibleOnly ?? false,
        };

        const result = await withSpinner('Updating server listing...', () => updateServerListing(client, id, body));

        if (flags.json) {
          renderJson(result);
          return;
        }

        ok('Server listing updated');
      },
    );
}
