import * as p from '@clack/prompts';
import { Command } from 'commander';
import React from 'react';
import { profileDetailFields } from '../../core/account/columns.js';
import { getProfile, updateProfile } from '../../core/account/profile.js';
import { getAuthenticatedClient } from '../../core/client.js';
import { DetailContent } from '../../tui/components/detail-view.js';
import { renderOnce } from '../../tui/render-once.js';
import { fail, ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerAccountProfileCommands(account: Command): void {
  const profileCmd = account
    .command('profile')
    .description('View or update your user profile')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
View your profile information (name, email) or update your name.

Examples:
  brokkr account profile                                    Show profile
  brokkr account profile --json                            Show profile as JSON
  brokkr account profile update                            Update profile (interactive)
  brokkr account profile update --first-name Augusto       Update first name
  brokkr account profile update --first-name A --last-name B  Update name`,
    )
    .action(async (flags: { json: boolean }) => {
      const profile = await withSpinner('Fetching profile...', () => getProfile());

      if (flags.json) {
        renderJson(profile);
        return;
      }

      renderOnce(<DetailContent title="User Profile" subtitle={profile.id} fields={profileDetailFields(profile)} />);
    });

  profileCmd
    .command('update')
    .description('Update your profile fields')
    .option('--first-name <name>', 'First name')
    .option('--last-name <name>', 'Last name')
    .option('--json', 'Output as JSON', false)
    .action(async (flags: { firstName?: string; lastName?: string; json: boolean }) => {
      const client = getAuthenticatedClient();

      let firstName = flags.firstName;
      let lastName = flags.lastName;

      const needsPrompts = firstName === undefined || lastName === undefined;

      if (needsPrompts) {
        const current = await withSpinner('Fetching current profile...', () => getProfile());

        if (firstName === undefined) {
          const currentFirst = current.firstName ?? current.name?.split(' ')[0] ?? '';
          firstName = prompt(
            await p.text({
              message: 'First name',
              placeholder: currentFirst,
              initialValue: currentFirst,
              validate: (v) => {
                if (!v.trim()) return 'First name is required';
              },
            }),
          );
        }

        if (lastName === undefined) {
          const nameParts = current.name?.split(' ') ?? [];
          const currentLast = current.lastName ?? (nameParts.length > 1 ? nameParts.slice(1).join(' ') : '');
          lastName = prompt(
            await p.text({
              message: 'Last name',
              placeholder: currentLast,
              initialValue: currentLast,
              validate: (v) => {
                if (!v.trim()) return 'Last name is required';
              },
            }),
          );
        }
      }

      const updateData: { firstName?: string; lastName?: string } = {};
      if (firstName !== undefined && firstName.trim()) updateData.firstName = firstName.trim();
      if (lastName !== undefined && lastName.trim()) updateData.lastName = lastName.trim();

      if (Object.keys(updateData).length === 0) {
        fail('No fields to update');
      }

      const updated = await withSpinner('Updating profile...', () => updateProfile(client, updateData));

      if (flags.json) {
        renderJson(updated);
        return;
      }

      ok('Profile updated');
    });
}
