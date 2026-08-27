import { Separator } from '@repo/ui/components/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@repo/ui/components/sidebar';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CreditCard, FolderGit2, Inbox, LayoutDashboard, MoreHorizontal, Plus, Server, Settings } from 'lucide-react';

const meta = {
  title: 'Navigation/Sidebar',
  component: Sidebar,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Composable application sidebar. `SidebarProvider` persists the open state in a ' +
          '`sidebar_state` cookie, toggles on Ctrl/Cmd+B, and on mobile viewports renders the ' +
          'sidebar as a Sheet drawer instead of a fixed panel.',
      },
    },
  },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

const NAV_ITEMS = [
  { icon: LayoutDashboard, label: 'Dashboard', isActive: true },
  { icon: Server, label: 'Devices' },
  { icon: Inbox, label: 'Inbox', badge: '12' },
  { icon: CreditCard, label: 'Billing' },
  { icon: Settings, label: 'Settings' },
];

export const AppFrame: Story = {
  render: () => (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="border-border-dim h-[72px] justify-center border-b">
          <div className="flex items-center gap-2 px-2">
            <div className="bg-accent/15 text-accent flex h-8 w-8 shrink-0 items-center justify-center rounded-md font-mono text-sm font-bold">
              H
            </div>
            <div className="flex flex-col leading-tight">
              <strong className="text-text-primary text-sm">Hydra</strong>
              <span className="text-text-dim text-[10px] tracking-widest">COMMERCE</span>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV_ITEMS.map(({ icon: Icon, label, isActive, badge }) => (
                  <SidebarMenuItem key={label}>
                    <SidebarMenuButton isActive={isActive}>
                      <Icon /> <span>{label}</span>
                    </SidebarMenuButton>
                    {badge ? <SidebarMenuBadge>{badge}</SidebarMenuBadge> : null}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="border-border-dim flex h-[72px] items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <h1 className="text-text-primary text-sm font-medium">Dashboard</h1>
        </header>
        <main className="flex flex-1 p-4">
          <div className="border-border text-text-muted flex flex-1 items-center justify-center border border-dashed font-mono text-xs">
            page content
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  ),
};

function SidebarStateFooter() {
  const { state } = useSidebar();
  return <span className="text-text-dim px-2 py-1.5 font-mono text-[10px]">state: {state}</span>;
}

export const WithSubmenus: Story = {
  render: () => (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <SidebarInput placeholder="Search…" />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <SidebarGroupAction title="Add project">
              <Plus /> <span className="sr-only">Add project</span>
            </SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive>
                    <FolderGit2 /> <span>Provisioning</span>
                  </SidebarMenuButton>
                  <SidebarMenuAction showOnHover title="More">
                    <MoreHorizontal /> <span className="sr-only">More</span>
                  </SidebarMenuAction>
                  <SidebarMenuSub>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton href="#" isActive>
                        <span>Bare metal</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton href="#">
                        <span>GPU clusters</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton href="#">
                        <span>Networking</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton>
                    <Server /> <span>Inventory</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarSeparator />
          <SidebarGroup>
            <SidebarGroupLabel>Loading</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {[0, 1, 2].map((i) => (
                  <SidebarMenuItem key={i}>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarStateFooter />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="border-border-dim flex h-[72px] items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <h1 className="text-text-primary text-sm font-medium">Projects</h1>
        </header>
        <main className="flex flex-1 p-4">
          <div className="border-border text-text-muted flex flex-1 items-center justify-center border border-dashed font-mono text-xs">
            page content
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  ),
};
