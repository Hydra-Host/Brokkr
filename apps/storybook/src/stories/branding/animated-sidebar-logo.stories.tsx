import { AnimatedSidebarLogo } from '@repo/ui/animated-sidebar-logo';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Branding/AnimatedSidebarLogo',
  component: AnimatedSidebarLogo,
  parameters: {
    docs: {
      description: {
        component:
          'Sidebar brand mark that shows the SVG logo for 3 seconds, deconstructs it into a ' +
          'random ASCII variant, then matrix-reveals the final ASCII wordmark. Expanding from ' +
          'the collapsed state replays the matrix reveal.',
      },
    },
  },
} satisfies Meta<typeof AnimatedSidebarLogo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { className: 'h-12' },
};

export const Collapsed: Story = {
  args: { collapsed: true },
};
