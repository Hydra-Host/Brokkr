import { ClickToCopyString } from '@repo/ui/components/click-to-copy-string';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Data Display/ClickToCopyString',
  component: ClickToCopyString,
  args: { value: 'usr_01HZY3V9K2Q8' },
} satisfies Meta<typeof ClickToCopyString>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const TruncatedLongValue: Story = {
  args: {
    value: 'sk_live_51OqX8mF2eZvKYlo2C9dGxT4bN7wJpRuA6sHhVcMnEyLQiD0KbWgUjPrT3aXs',
    truncate: true,
    maxWidth: '220px',
    tooltipSide: 'bottom',
  },
};

export const WithDisplayValue: Story = {
  args: {
    value: '8f14e45f-ceea-467f-a9d2-4b6c1f0e5a3d',
    displayValue: 'Copy device ID',
  },
};
