import { AsciiLogo, AsciiLogoCompact } from '@repo/ui/ascii-logo';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Branding/AsciiLogo',
  component: AsciiLogo,
  parameters: {
    docs: {
      description: {
        component:
          'ASCII wordmark rendered from `ASCII_LOGOS`. When `logoIndex` is omitted the ' +
          'component picks a random variant on mount, so stories pin an explicit index to ' +
          'stay deterministic.',
      },
    },
  },
  argTypes: {
    logoIndex: { control: { type: 'number', min: 0, max: 3, step: 1 } },
  },
} satisfies Meta<typeof AsciiLogo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { logoIndex: 0 },
};

export const Compact: Story = {
  render: (args) => <AsciiLogoCompact {...args} />,
  args: { logoIndex: 0 },
};

export const AlternateVariant: Story = {
  args: { logoIndex: 2 },
};

export const SideBySide: Story = {
  render: () => (
    <div className="flex flex-col gap-8">
      <div>
        <p className="text-text-muted mb-2 font-mono text-xs">AsciiLogo</p>
        <AsciiLogo logoIndex={0} />
      </div>
      <div>
        <p className="text-text-muted mb-2 font-mono text-xs">AsciiLogoCompact</p>
        <AsciiLogoCompact logoIndex={0} />
      </div>
    </div>
  ),
};
