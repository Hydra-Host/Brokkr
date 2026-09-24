import { ThemeSelector } from '@repo/ui/theme-selector';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Foundations/ThemeSelector',
  component: ThemeSelector,
  parameters: {
    docs: {
      description: {
        component:
          'Dropdown for picking the style, color, and mode axes, backed by the same `ThemeProvider` ' +
          'context the Storybook toolbar drives. The menu stays open while adjusting and closes on ' +
          'click outside. Choices persist to localStorage (`brokkr-style`, `brokkr-color`, ' +
          '`brokkr-mode`); System mode follows the OS light/dark preference.',
      },
    },
  },
} satisfies Meta<typeof ThemeSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
