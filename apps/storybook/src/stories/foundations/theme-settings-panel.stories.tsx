import { ThemeSettingsPanel } from '@repo/ui/theme-settings-panel';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Foundations/ThemeSettingsPanel',
  component: ThemeSettingsPanel,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Full settings-page body for the theme axes — one card per axis: mode (right-aligned ' +
          'segmented control), style (live mini-previews), and color. Backed by the same ' +
          '`ThemeProvider` context as `ThemeSelector`; apps wrap it in their own page chrome ' +
          '(boss `/account/theme`, commerce admin `/theme`).',
      },
    },
  },
} satisfies Meta<typeof ThemeSettingsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
