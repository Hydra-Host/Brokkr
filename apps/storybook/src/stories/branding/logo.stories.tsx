import { Logo } from '@repo/ui/logo';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Branding/Logo',
  component: Logo,
  parameters: {
    docs: {
      description: {
        component:
          'Brokkr wordmark SVG. All paths fill with `currentColor`; the built-in ' +
          '`.logo-colored` class (base layer) sets `color: var(--color-accent)`, so a text ' +
          'color utility passed via `className` overrides it.',
      },
    },
  },
} satisfies Meta<typeof Logo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <Logo className="h-10 w-auto" />,
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <div className="flex items-center gap-4">
        <span className="text-text-muted w-12 font-mono text-xs">h-6</span>
        <Logo className="h-6 w-auto" />
      </div>
      <div className="flex items-center gap-4">
        <span className="text-text-muted w-12 font-mono text-xs">h-10</span>
        <Logo className="h-10 w-auto" />
      </div>
      <div className="flex items-center gap-4">
        <span className="text-text-muted w-12 font-mono text-xs">h-16</span>
        <Logo className="h-16 w-auto" />
      </div>
    </div>
  ),
};

export const ColoredVsCurrentColor: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <div className="flex items-center gap-4">
        <span className="text-text-muted w-32 font-mono text-xs">.logo-colored</span>
        <Logo className="h-10 w-auto" />
      </div>
      <div className="flex items-center gap-4">
        <span className="text-text-muted w-32 font-mono text-xs">text-text-primary</span>
        <Logo className="text-text-primary h-10 w-auto" />
      </div>
      <div className="flex items-center gap-4">
        <span className="text-text-muted w-32 font-mono text-xs">text-text-muted</span>
        <Logo className="text-text-muted h-10 w-auto" />
      </div>
    </div>
  ),
};
