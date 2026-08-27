import { ThemeSelector } from '@repo/ui/theme-selector';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Foundations/ThemeSelector',
  component: ThemeSelector,
  parameters: {
    docs: {
      description: {
        component:
          'Dropdown for picking a theme or System mode, backed by the same `ThemeProvider` context the ' +
          'Storybook toolbar drives — selecting a theme here mutates the toolbar theme and vice versa. ' +
          'Choices persist to localStorage (`brokkr-theme`, `brokkr-preferred-dark`, ' +
          '`brokkr-preferred-light`); System mode follows the OS light/dark preference using the ' +
          'preferred theme for each.',
      },
    },
  },
} satisfies Meta<typeof ThemeSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
