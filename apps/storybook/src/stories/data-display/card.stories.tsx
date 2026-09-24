import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@repo/ui/components/card';
import { Separator } from '@repo/ui/components/separator';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Data Display/Card',
  component: Card,
  parameters: {
    docs: {
      description: {
        component:
          'Terminal-styled surface. The decorative corner ticks sit on the ' +
          'card border and are hidden under the modern style (the border ' +
          'and tick colors match) — switch the toolbar style to `retro` ' +
          'to see them.',
      },
    },
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card className="w-[420px]">
      <CardHeader>
        <CardTitle>gpu-node-014</CardTitle>
        <CardDescription>Bare metal · us-east-1 · Ashburn</CardDescription>
        <CardAction>
          <Badge variant="online" size="sm">
            Online
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          <dt className="text-text-muted">CPU</dt>
          <dd>2× AMD EPYC 9654 (192 cores)</dd>
          <dt className="text-text-muted">GPU</dt>
          <dd>8× NVIDIA H100 SXM 80GB</dd>
          <dt className="text-text-muted">Memory</dt>
          <dd>2 TB DDR5</dd>
          <dt className="text-text-muted">Storage</dt>
          <dd>4× 7.68 TB NVMe</dd>
        </dl>
      </CardContent>
      <Separator />
      <CardFooter className="justify-between">
        <span className="text-text-muted text-xs">Provisioned 2026-03-18</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
            Reboot
          </Button>
          <Button size="sm">Manage</Button>
        </div>
      </CardFooter>
    </Card>
  ),
};

export const HeaderOnly: Story = {
  render: () => (
    <Card className="w-[420px]">
      <CardHeader>
        <CardTitle>Billing</CardTitle>
        <CardDescription>Invoices, balances and payment methods</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm">
            View
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  ),
};
