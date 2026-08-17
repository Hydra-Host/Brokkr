import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import React from 'react';
import { sshKeyDetailFields, sshKeyListColumns } from '../../core/account/columns.js';
import { createSshKey, deleteSshKey, getSshKey, listSshKeys } from '../../core/account/ssh-keys.js';
import { getAuthenticatedClient } from '../../core/client.js';
import { DetailContent } from '../../tui/components/detail-view.js';
import { StaticTable } from '../../tui/components/static-table.js';
import { renderOnce } from '../../tui/render-once.js';
import { ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import {
  fetchPage,
  paginationFooter,
  paginationOptions,
  renderJson,
  withSpinner,
  type PaginationFlags,
} from '../../ui/table.js';

export function registerAccountSshKeysCommands(account: Command): void {
  const sshKeysCmd = paginationOptions(
    account
      .command('ssh-keys')
      .description('List your SSH keys, or show one by ID')
      .argument('[id]', 'SSH key ID to show details for'),
  )
    .addHelpText(
      'after',
      `
List your SSH public keys. With an ID, shows full key details including fingerprint.

Examples:
  brokkr account ssh-keys                  List all SSH keys
  brokkr account ssh-keys --json           List as JSON
  brokkr account ssh-keys --page-size 50   Larger page
  brokkr account ssh-keys <id>             Show key details
  brokkr account ssh-keys <id> --json      Show key details as JSON`,
    )
    .action(async (id: string | undefined, flags: PaginationFlags, cmd: Command) => {
      if (id?.startsWith('-')) {
        cmd.help();
        return;
      }
      if (id) {
        await showSshKeyAction(id, flags.json);
      } else {
        await listSshKeysAction(flags);
      }
    });

  sshKeysCmd
    .command('add')
    .description('Add a new SSH public key')
    .option('--name <name>', 'Display name for the key')
    .option('--key <key>', 'SSH public key in OpenSSH format')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Registers a new SSH public key for your account. The key must be in OpenSSH format.

Examples:
  brokkr account ssh-keys add                                         Interactive mode
  brokkr account ssh-keys add --name "My Key" --key "ssh-ed25519 AAAA..."
  brokkr account ssh-keys add --name "My Key" --key "ssh-ed25519 AAAA..." --json`,
    )
    .action(async (flags: { name?: string; key?: string; json: boolean }) => {
      let name = flags.name;
      let keyValue = flags.key;

      if (name === undefined) {
        name = prompt(
          await p.text({
            message: 'Key name',
            placeholder: 'My SSH Key',
            validate: (v) => {
              if (!v.trim()) return 'Name is required';
            },
          }),
        );
      }

      if (keyValue === undefined) {
        keyValue = prompt(
          await p.text({
            message: 'Public key',
            placeholder: 'ssh-ed25519 AAAA... user@host',
            validate: (v) => {
              const trimmed = v.trim();
              if (!trimmed) return 'Public key is required';
              if (!trimmed.startsWith('ssh-') && !trimmed.startsWith('ecdsa-') && !trimmed.startsWith('sk-')) {
                return 'Must be a valid OpenSSH public key (starts with ssh-ed25519, ssh-rsa, etc.)';
              }
            },
          }),
        );
      }

      const created = await withSpinner('Adding SSH key...', async () => {
        const client = getAuthenticatedClient();
        return createSshKey(client, { name: name!, key: keyValue! });
      });

      if (flags.json) {
        renderJson(created);
        return;
      }

      ok(`SSH key added: ${chalk.bold(created.name)}`);
    });

  sshKeysCmd
    .command('delete <id>')
    .description('Delete an SSH key')
    .option('--force', 'Skip confirmation prompt', false)
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Soft-deletes an SSH key. The key will no longer be available for new provisioning.

Examples:
  brokkr account ssh-keys delete <id>              Interactive (prompts for confirmation)
  brokkr account ssh-keys delete <id> --force      Skip confirmation
  brokkr account ssh-keys delete <id> --force --json`,
    )
    .action(async (id: string, flags: { force: boolean; json: boolean }) => {
      const client = getAuthenticatedClient();

      if (!flags.force) {
        const key = await withSpinner('Fetching SSH key...', () => getSshKey(client, id));

        const confirmed = prompt(
          await p.confirm({
            message: `Delete SSH key "${key.name}" (${key.fingerprint})?`,
            initialValue: false,
          }),
        );

        if (!confirmed) {
          p.cancel('Cancelled');
          process.exit(0);
        }
      }

      const deleted = await withSpinner('Deleting SSH key...', () => deleteSshKey(client, id));

      if (flags.json) {
        renderJson(deleted);
        return;
      }

      ok('SSH key deleted');
    });
}

async function listSshKeysAction(flags: PaginationFlags): Promise<void> {
  const result = await withSpinner('Fetching SSH keys...', async () => {
    const client = getAuthenticatedClient();
    return fetchPage((query) => listSshKeys(client, query), flags);
  });

  if (flags.json) {
    renderJson(result);
    return;
  }

  renderOnce(
    <StaticTable
      title="SSH Keys"
      columns={sshKeyListColumns}
      rows={result.data}
      footer={paginationFooter(result.meta, 'brokkr account ssh-keys')}
    />,
  );
}

async function showSshKeyAction(id: string, json: boolean): Promise<void> {
  const key = await withSpinner(`Fetching SSH key ${id}...`, async () => {
    const client = getAuthenticatedClient();
    return getSshKey(client, id);
  });

  if (json) {
    renderJson(key);
    return;
  }

  renderOnce(<DetailContent title={key.name} subtitle={key.id} fields={sshKeyDetailFields(key)} />);
}
