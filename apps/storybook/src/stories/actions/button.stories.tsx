import { Button } from '@repo/ui/components/button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ArrowRight, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import React from 'react';

const VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'link', 'destructive', 'success', 'warning'] as const;
const SIZES = ['sm', 'default', 'lg', 'icon'] as const;

const meta = {
  title: 'Actions/Button',
  component: Button,
  argTypes: {
    variant: { control: 'select', options: VARIANTS },
    size: { control: 'select', options: SIZES },
    asChild: { control: false },
  },
  args: { variant: 'default', size: 'default', children: 'Button' },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllVariants: Story = {
  render: () => (
    <div className="grid grid-cols-[auto_repeat(4,auto)] items-center gap-4">
      <span />
      {SIZES.map((size) => (
        <span key={size} className="text-text-muted text-xs">
          {size}
        </span>
      ))}
      {VARIANTS.map((variant) => (
        <React.Fragment key={variant}>
          <span className="text-text-muted text-xs">{variant}</span>
          {SIZES.map((size) => (
            <Button key={size} variant={variant} size={size}>
              {size === 'icon' ? <Plus /> : 'Button'}
            </Button>
          ))}
        </React.Fragment>
      ))}
    </div>
  ),
};

export const WithIcon: Story = {
  render: () => (
    <div className="flex gap-3">
      <Button>
        <Plus /> New device
      </Button>
      <Button variant="outline">
        Continue <ArrowRight />
      </Button>
      <Button variant="destructive">
        <Trash2 /> Delete
      </Button>
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <Button disabled>
      <LoaderCircle className="animate-spin" /> Provisioning…
    </Button>
  ),
};

export const Disabled: Story = { args: { disabled: true } };

export const AsChild: Story = {
  render: () => (
    <Button asChild variant="link">
      <a href="https://example.com">Rendered as an anchor via asChild</a>
    </Button>
  ),
};
