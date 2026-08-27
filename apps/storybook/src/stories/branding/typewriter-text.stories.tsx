import { TypewriterText } from '@repo/ui/components/typewriter-text';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Branding/TypewriterText',
  component: TypewriterText,
  argTypes: {
    as: {
      control: 'select',
      options: ['span', 'h1', 'h2', 'h3', 'p', 'div'],
    },
  },
} satisfies Meta<typeof TypewriterText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    text: 'Provisioning bare metal at the speed of software.',
    className: 'font-mono text-sm text-text-primary',
  },
};

export const Heading: Story = {
  args: {
    text: 'Welcome to Hydra',
    as: 'h1',
    className: 'font-mono text-3xl font-bold text-accent',
  },
};

export const SlowSpeed: Story = {
  args: {
    text: 'One character every 120 milliseconds…',
    speed: 120,
    className: 'font-mono text-sm text-text-muted',
  },
};
