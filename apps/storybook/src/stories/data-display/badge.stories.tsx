import { Badge } from '@repo/ui/components/badge';
import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

const VARIANTS = [
  'default',
  'secondary',
  'destructive',
  'outline',
  'success',
  'warning',
  'online',
  'offline',
  'price',
  'info',
  'purple',
] as const;
const SIZES = ['sm', 'md', 'lg'] as const;

const meta = {
  title: 'Data Display/Badge',
  component: Badge,
  argTypes: {
    variant: { control: 'select', options: VARIANTS },
    size: { control: 'select', options: SIZES },
  },
  args: { variant: 'default', size: 'md', children: 'Badge' },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllVariants: Story = {
  render: () => (
    <div className="grid grid-cols-[auto_repeat(3,auto)] items-center gap-x-6 gap-y-3">
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
            <Badge key={size} variant={variant} size={size}>
              {variant}
            </Badge>
          ))}
        </React.Fragment>
      ))}
    </div>
  ),
};

export const StatusRow: Story = {
  render: () => (
    <div className="border-border flex w-[560px] items-center justify-between border px-4 py-3 font-mono text-sm">
      <div className="flex flex-col gap-1">
        <span className="text-text-primary">gpu-node-014.iad1</span>
        <span className="text-text-muted text-xs">8× H100 SXM · 2 TB DDR5</span>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="online" size="sm">
          Online
        </Badge>
        <Badge variant="info" size="sm">
          Reserved
        </Badge>
        <Badge variant="price" size="sm">
          $2.15/hr
        </Badge>
      </div>
    </div>
  ),
};
