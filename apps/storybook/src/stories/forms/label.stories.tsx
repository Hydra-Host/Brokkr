import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Forms/Primitives/Label',
  component: Label,
  args: { children: 'Hostname' },
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Required: Story = {
  render: () => (
    <Label htmlFor="api-key">
      API key <span className="text-status-offline">*</span>
    </Label>
  ),
};

export const WithInput: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <Label htmlFor="hostname">Hostname</Label>
      <Input id="hostname" placeholder="gpu-node-01" />
      <p className="text-text-dim font-mono text-xs">Clicking the label focuses the input via htmlFor.</p>
    </div>
  ),
};
