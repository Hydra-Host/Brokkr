import { Button } from '@repo/ui/components/button';
import { Separator } from '@repo/ui/components/separator';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Data Display/Separator',
  component: Separator,
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <div className="w-80 font-mono">
      <div className="space-y-1">
        <h4 className="text-text-primary text-sm font-medium">Brokkr UI</h4>
        <p className="text-text-muted text-sm">Terminal-styled component library.</p>
      </div>
      <Separator className="my-4" />
      <p className="text-text-muted text-sm">Shared between Boss and Commerce via @repo/ui.</p>
    </div>
  ),
};

export const VerticalInToolbar: Story = {
  render: () => (
    <div className="flex h-9 items-center gap-3 font-mono text-sm">
      <Button variant="ghost" size="sm">
        Overview
      </Button>
      <Separator orientation="vertical" className="h-5" />
      <Button variant="ghost" size="sm">
        Devices
      </Button>
      <Separator orientation="vertical" className="h-5" />
      <Button variant="ghost" size="sm">
        Billing
      </Button>
    </div>
  ),
};
