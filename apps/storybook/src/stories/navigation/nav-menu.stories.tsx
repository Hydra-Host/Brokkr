import { Logo } from '@repo/ui/components/logos/logo';
import {
  NavAccordion,
  NavDragHandle,
  NavDropIndicator,
  NavEmptyHint,
  NavPinButton,
  NavRow,
  NavSectionLabel,
  NavTab,
  NavTabList,
  NavTabPanel,
  NavTabs,
  navPrimaryLinkClassName,
  navRowClassName,
} from '@repo/ui/components/nav-menu';
import { cn } from '@repo/ui/utils';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookOpen, Building2, Database, Globe, LayoutDashboard, Server, Settings2, Star } from 'lucide-react';
import { useState } from 'react';

const meta = {
  title: 'Navigation/NavMenu',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Presentational building blocks of the app sidebar: accordion sections, pinned/recent tabs, leaf rows with a hover-revealed pin button, drag affordances and the footer label. Router-agnostic — render your own links with `navRowClassName` / `navPrimaryLinkClassName`. Switch the Style toolbar to see the retro (square, separators) and modern (rounded, inset rows) treatments.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Row({
  title,
  active = false,
  pinned = false,
  inset = 'pl-10',
  draggable = false,
  dragging = false,
  drop,
}: {
  title: string;
  active?: boolean;
  pinned?: boolean;
  inset?: string;
  draggable?: boolean;
  dragging?: boolean;
  drop?: 'above' | 'below';
}) {
  const [isPinned, setPinned] = useState(pinned);
  return (
    <NavRow dragging={dragging}>
      {drop && <NavDropIndicator position={drop} />}
      {draggable && <NavDragHandle />}
      <a href="#" data-slot="nav-leaf" data-active={active || undefined} className={cn(navRowClassName, inset)}>
        <span className="truncate">{title}</span>
      </a>
      <NavPinButton pinned={isPinned} active={active} label={title} onToggle={() => setPinned((p) => !p)} />
    </NavRow>
  );
}

function Section({
  icon,
  title,
  defaultOpen = false,
  children,
}: {
  icon: typeof Database;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <NavAccordion icon={icon} title={title} open={open} onToggle={() => setOpen((o) => !o)}>
      {children}
    </NavAccordion>
  );
}

function Favorites() {
  const [tab, setTab] = useState('pinned');
  return (
    <NavTabs value={tab} onValueChange={setTab}>
      <NavTabList>
        <NavTab value="pinned">Pinned</NavTab>
        <NavTab value="recent">Recent</NavTab>
      </NavTabList>
      <NavTabPanel value="pinned">
        <ul className="flex flex-col">
          <Row title="Servers" pinned draggable />
          <Row title="Bridges" pinned draggable />
        </ul>
      </NavTabPanel>
      <NavTabPanel value="recent">
        <NavEmptyHint>Pages you visit show up here</NavEmptyHint>
      </NavTabPanel>
    </NavTabs>
  );
}

export const FullSidebar: Story = {
  render: () => (
    <div className="bg-sidebar text-sidebar-foreground border-sidebar-border flex h-[720px] w-64 flex-col border-r">
      <div className="border-sidebar-border flex h-16 shrink-0 items-center justify-center overflow-hidden border-b px-2">
        <Logo className="h-12 w-auto" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <a href="#" data-active className={navPrimaryLinkClassName}>
          <LayoutDashboard className="size-4 shrink-0" />
          Dashboard
        </a>
        <Section icon={Star} title="Favorites" defaultOpen>
          <Favorites />
        </Section>
        <Section icon={Database} title="Zone Management" defaultOpen>
          <ul className="flex flex-col">
            <Row title="Zones" />
            <Row title="Bridges" pinned />
            <Row title="Servers" active />
            <Row title="Switches" />
            <Row title="Routers" />
          </ul>
        </Section>
        <Section icon={Globe} title="IPAM">
          <ul className="flex flex-col">
            <Row title="VRFs" />
            <Row title="Prefixes" />
          </ul>
        </Section>
        <Section icon={Building2} title="Physical Infrastructure">
          <ul className="flex flex-col">
            <Row title="Racks" />
          </ul>
        </Section>
        <Section icon={Server} title="Rentals">
          <ul className="flex flex-col">
            <Row title="Deployments" />
          </ul>
        </Section>
        <Section icon={BookOpen} title="Documentation">
          <ul className="flex flex-col">
            <Row title="Overview" />
          </ul>
        </Section>
      </div>
      <nav aria-label="Organization Settings" className="border-sidebar-border shrink-0 border-t pb-1">
        <NavSectionLabel>Organization Settings</NavSectionLabel>
        <ul className="flex flex-col">
          <Row title="Members" inset="pl-4" />
          <Row title="Roles" inset="pl-4" />
          <Row title="API Keys" inset="pl-4" />
          <Row title="Settings" inset="pl-4" />
        </ul>
      </nav>
    </div>
  ),
};

export const Sections: Story = {
  render: () => (
    <div className="bg-sidebar w-64">
      <Section icon={Database} title="Zone Management" defaultOpen>
        <ul className="flex flex-col">
          <Row title="Zones" />
          <Row title="Servers" active />
        </ul>
      </Section>
      <Section icon={Globe} title="IPAM">
        <ul className="flex flex-col">
          <Row title="VRFs" />
        </ul>
      </Section>
      <Section icon={Settings2} title="A very long section title that truncates">
        <ul className="flex flex-col">
          <Row title="Item" />
        </ul>
      </Section>
    </div>
  ),
};

export const RowStates: Story = {
  render: () => (
    <div className="bg-sidebar w-64 py-2">
      <ul className="flex flex-col">
        <Row title="Default" />
        <Row title="Pinned" pinned />
        <Row title="Active" active />
        <Row title="Active and pinned" active pinned />
        <Row title="Draggable" pinned draggable />
        <Row title="Dragging" pinned draggable dragging />
        <Row title="Drop target above" pinned draggable drop="above" />
        <Row title="Footer inset" inset="pl-4" />
      </ul>
    </div>
  ),
};

export const FavoritesTabs: Story = {
  render: () => (
    <div className="bg-sidebar w-64 py-2">
      <Favorites />
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div className="bg-sidebar w-64 py-2">
      <NavEmptyHint>Pin a page to add it here</NavEmptyHint>
    </div>
  ),
};
