import { Box, Text, useInput } from 'ink';
import React, { useMemo, useState } from 'react';
import { getActiveOrg } from '../../config/store.js';
import { isSupplier } from '../../core/permissions.js';
import { useRouter } from '../router.js';

interface MenuItem {
  label: string;
  screen: string;
  title: string;
}

interface MenuSection {
  title: string;
  items: MenuItem[];
  supplierOnly?: boolean;
}

const SECTIONS: MenuSection[] = [
  {
    title: 'Deployments',
    items: [
      { label: 'All Deployments', screen: 'deployments', title: 'All Deployments' },
      { label: 'Projects', screen: 'projects', title: 'Projects' },
    ],
  },
  {
    title: 'Rent Servers',
    items: [{ label: 'Available Servers', screen: 'inventory-list', title: 'Available Servers' }],
  },
  {
    title: 'DCIM',
    supplierOnly: true,
    items: [
      { label: 'Data Centers', screen: 'datacenters', title: 'Data Centers' },
      { label: 'Bridges', screen: 'bridges', title: 'Bridges' },
      { label: 'Servers (Active)', screen: 'servers', title: 'Servers (Active)' },
      { label: 'Servers (Decommissioned)', screen: 'decommissioned-servers', title: 'Servers (Decommissioned)' },
    ],
  },
  {
    title: 'Organization',
    items: [
      { label: 'Settings', screen: 'org-settings', title: 'Organization Settings' },
      { label: 'Members', screen: 'org-members', title: 'Members' },
      { label: 'Invitations', screen: 'org-invitations', title: 'Invitations' },
      { label: 'API Keys', screen: 'org-api-keys', title: 'API Keys' },
      { label: 'Webhooks', screen: 'org-webhooks', title: 'Webhooks' },
    ],
  },
  {
    title: 'Account',
    items: [
      { label: 'Profile', screen: 'account-profile', title: 'User Profile' },
      { label: 'SSH Keys', screen: 'account-ssh-keys', title: 'SSH Keys' },
    ],
  },
];

function filterSections(tenantType: string | undefined): MenuSection[] {
  return SECTIONS.filter((section) => !section.supplierOnly || isSupplier(tenantType));
}

export function HomeScreen() {
  const { push } = useRouter();
  const org = getActiveOrg();
  const sections = useMemo(() => filterSections(org?.tenantType), [org?.tenantType]);
  const allItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(allItems.length - 1, c + 1));
    else if (key.return) {
      const item = allItems[cursor]!;
      push({ screen: item.screen, title: item.title });
    } else if (input === 'q') process.exit(0);
  });

  let itemIndex = 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      {sections.map((section) => {
        const sectionItems = section.items.map((item) => {
          const i = itemIndex++;
          const selected = i === cursor;
          return (
            <Box key={item.screen}>
              <Text color={selected ? 'cyan' : undefined}>
                {selected ? '▸' : ' '} {item.label}
              </Text>
            </Box>
          );
        });

        return (
          <Box key={section.title} flexDirection="column" marginBottom={1}>
            <Box marginBottom={0}>
              <Text bold>{section.title}</Text>
            </Box>
            {sectionItems}
          </Box>
        );
      })}
      <Box>
        <Text>↑↓ navigate ⏎ select q quit</Text>
      </Box>
    </Box>
  );
}
