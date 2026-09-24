import type { SidebarNavContribution } from '@hydrahost/plugin-sdk';
import { isRecord } from '@repo/utils';
import { Puzzle } from 'lucide-react';

import type { NavSection } from '~/lib/nav';

import { contributionAllowed } from './contribution-permission';
import { wrapPluginIcon } from './safe-plugin-icon';

function isSidebarNavContribution(contribution: unknown): contribution is SidebarNavContribution {
  return isRecord(contribution) && typeof contribution.to === 'string' && typeof contribution.label === 'string';
}

export function buildPluginSections(
  entries: ReadonlyArray<{ pluginId: string; contribution: unknown }>,
  can: (resource: string, action: string) => boolean,
  isLoadingPermissions: boolean,
): NavSection[] {
  const bySection = new Map<string, NavSection>();
  for (const entry of entries) {
    if (!isSidebarNavContribution(entry.contribution)) continue;
    const c = entry.contribution;
    if (!contributionAllowed(c.requiredPermission, can, isLoadingPermissions)) continue;
    const title = c.section ?? 'Plugins';
    const key = title.toLowerCase();
    const sectionIcon = c.sectionIcon ? wrapPluginIcon(entry.pluginId, c.sectionIcon, Puzzle) : Puzzle;
    const leafIcon = c.icon ? wrapPluginIcon(entry.pluginId, c.icon, Puzzle) : Puzzle;
    let section = bySection.get(key);
    if (!section) {
      section = { title, icon: sectionIcon, items: [] };
      bySection.set(key, section);
    } else if (c.sectionIcon && section.icon === Puzzle) {
      section.icon = sectionIcon;
    }
    section.items.push({ title: c.label, url: c.to, icon: leafIcon, external: c.external, popup: c.popup });
  }
  return [...bySection.values()];
}
