import { Progress } from '@repo/ui/components/progress';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';

const meta = {
  title: 'Data Display/Progress',
  component: Progress,
  args: { value: 50, className: 'w-64' },
  argTypes: {
    value: { control: { type: 'range', min: 0, max: 100, step: 1 } },
  },
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const StaticValues: Story = {
  render: () => (
    <div className="w-64 space-y-4">
      {[25, 50, 75].map((value) => (
        <div key={value} className="space-y-1">
          <span className="text-text-muted font-mono text-xs">{value}%</span>
          <Progress value={value} />
        </div>
      ))}
    </div>
  ),
};

function AnimatedProgress() {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setValue((prev) => (prev >= 100 ? 0 : prev + 5)), 400);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="w-64 space-y-1">
      <span className="text-text-muted font-mono text-xs">Provisioning… {value}%</span>
      <Progress value={value} />
    </div>
  );
}

export const Animated: Story = {
  render: () => <AnimatedProgress />,
};
