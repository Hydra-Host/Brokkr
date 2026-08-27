import { Label } from '@repo/ui/components/label';
import { Slider } from '@repo/ui/components/slider';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

// Note: the @repo/ui Slider renders a single thumb, so base-ui range mode
// (array values with one thumb per index) is not supported by this wrapper.
const meta = {
  title: 'Forms/Primitives/Slider',
  component: Slider,
  argTypes: {
    disabled: { control: 'boolean' },
  },
  args: { min: 0, max: 100 },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { defaultValue: 40 },
};

export const Stepped: Story = {
  args: { defaultValue: 32, min: 0, max: 128, step: 8 },
};

export const Disabled: Story = {
  args: { defaultValue: 60, disabled: true },
};

const GpuCountDemo = () => {
  const [count, setCount] = useState(4);

  return (
    <div className="flex w-80 flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="gpu-count">GPUs per node</Label>
        <span className="text-text-primary font-mono text-sm">{count}×</span>
      </div>
      <Slider
        id="gpu-count"
        min={1}
        max={8}
        step={1}
        value={count}
        onValueChange={(value) => setCount(Array.isArray(value) ? (value[0] ?? 1) : value)}
      />
      <p className="text-text-dim font-mono text-xs">{count * 80} GB total HBM3 · H100 SXM</p>
    </div>
  );
};

export const GpuCount: Story = {
  render: () => <GpuCountDemo />,
};
