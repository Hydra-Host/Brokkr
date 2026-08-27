import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/components/tabs';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Navigation/Tabs',
  component: Tabs,
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="w-[420px]">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <p className="text-text-primary text-sm">High-level summary of the resource.</p>
      </TabsContent>
      <TabsContent value="activity">
        <p className="text-text-primary text-sm">Recent events and audit trail.</p>
      </TabsContent>
      <TabsContent value="settings">
        <p className="text-text-primary text-sm">Configuration options.</p>
      </TabsContent>
    </Tabs>
  ),
};

export const WithCards: Story = {
  render: () => (
    <Tabs defaultValue="account" className="w-[420px]">
      <TabsList>
        <TabsTrigger value="account">Account</TabsTrigger>
        <TabsTrigger value="billing">Billing</TabsTrigger>
      </TabsList>
      <TabsContent value="account">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>Organization profile and contact details.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-text-muted text-sm">Name, legal entity, and primary contact live here.</p>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="billing">
        <Card>
          <CardHeader>
            <CardTitle>Billing</CardTitle>
            <CardDescription>Payment methods and invoices.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-text-muted text-sm">Manage external accounts and view invoice history.</p>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  ),
};

export const WithDisabledTab: Story = {
  render: () => (
    <Tabs defaultValue="general" className="w-[420px]">
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="advanced" disabled>
          Advanced
        </TabsTrigger>
        <TabsTrigger value="danger">Danger zone</TabsTrigger>
      </TabsList>
      <TabsContent value="general">
        <p className="text-text-primary text-sm">The Advanced tab is disabled.</p>
      </TabsContent>
      <TabsContent value="danger">
        <p className="text-text-primary text-sm">Careful in here.</p>
      </TabsContent>
    </Tabs>
  ),
};
