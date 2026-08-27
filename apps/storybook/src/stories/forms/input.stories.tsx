import { Input } from '@repo/ui/components/input';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Search } from 'lucide-react';

const meta = {
  title: 'Forms/Primitives/Input',
  component: Input,
  argTypes: {
    type: {
      control: 'select',
      options: ['text', 'email', 'password', 'number', 'date'],
    },
  },
  args: { type: 'text' },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { defaultValue: 'gpu-node-01' },
};

export const WithPlaceholder: Story = {
  args: { placeholder: 'e.g. gpu-node-01' },
};

export const Disabled: Story = {
  args: { defaultValue: 'db-primary-01', disabled: true },
};

export const Invalid: Story = {
  args: { defaultValue: '300.10.0.1', 'aria-invalid': true },
};

export const HideCorners: Story = {
  args: { placeholder: 'No corner accents', hideCorners: true },
};

export const WithIcon: Story = {
  render: () => (
    <div className="relative w-80">
      <Search className="text-text-dim pointer-events-none absolute top-1/2 left-3 z-10 h-4 w-4 -translate-y-1/2" />
      <Input type="search" placeholder="Search devices…" className="pl-9" />
    </div>
  ),
};
