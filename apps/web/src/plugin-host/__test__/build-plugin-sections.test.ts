import { Puzzle } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import type { NavIcon } from '~/lib/nav';

import { buildPluginSections } from '../build-plugin-sections';

const WalletIcon: NavIcon = () => null;

const canBillingRead = (resource: string, action: string) => resource === 'billing' && action === 'read';
const denyAll = () => false;

const billing = {
  pluginId: 'commerce',
  contribution: {
    label: 'Billing',
    to: '/billing',
    section: 'Account',
    requiredPermission: { resource: 'billing', action: 'read' },
  },
};

const docs = {
  pluginId: 'docs',
  contribution: {
    label: 'Docs',
    to: '/docs',
    section: 'Account',
  },
};

function titles(sections: ReturnType<typeof buildPluginSections>) {
  return sections.map((section) => ({
    title: section.title,
    items: section.items.map((item) => ({ title: item.title, url: item.url })),
  }));
}

describe('buildPluginSections', () => {
  it('excludes a gated entry when the member lacks permission', () => {
    expect(titles(buildPluginSections([billing], denyAll, false))).toEqual([]);
  });

  it('excludes a gated entry while permissions are loading', () => {
    expect(titles(buildPluginSections([billing], canBillingRead, true))).toEqual([]);
  });

  it('keeps unrestricted entries regardless of permission state', () => {
    expect(titles(buildPluginSections([docs], denyAll, true))).toEqual([
      { title: 'Account', items: [{ title: 'Docs', url: '/docs' }] },
    ]);
  });

  it('drops a section when every entry is filtered out', () => {
    expect(titles(buildPluginSections([billing, billing], denyAll, false))).toEqual([]);
  });

  it('keeps the section when a sibling unrestricted entry remains', () => {
    expect(titles(buildPluginSections([billing, docs], denyAll, false))).toEqual([
      { title: 'Account', items: [{ title: 'Docs', url: '/docs' }] },
    ]);
  });

  it('promotes sectionIcon from a later entry when the first had none', () => {
    const [section] = buildPluginSections(
      [
        docs,
        {
          pluginId: 'commerce',
          contribution: { ...billing.contribution, sectionIcon: WalletIcon },
        },
      ],
      canBillingRead,
      false,
    );
    expect(section?.icon).not.toBe(Puzzle);
  });

  it('keeps the first sectionIcon when a later entry also supplies one', () => {
    const first = {
      pluginId: 'docs',
      contribution: { ...docs.contribution, sectionIcon: WalletIcon },
    };
    const second = {
      pluginId: 'commerce',
      contribution: { ...billing.contribution, sectionIcon: WalletIcon },
    };
    const [section] = buildPluginSections([first, second], canBillingRead, false);
    const [onlyFirst] = buildPluginSections([first], canBillingRead, false);
    expect(section?.icon).toBe(onlyFirst?.icon);
  });
});
