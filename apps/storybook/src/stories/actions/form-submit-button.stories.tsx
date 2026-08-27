import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Actions/FormSubmitButton',
  component: FormSubmitButton,
  parameters: {
    docs: {
      description: {
        component:
          'A type="submit" Button with a built-in loading spinner. No react-hook-form context is required — `pending` is a plain prop; pass your mutation/formState pending flag and the button disables itself and shows the spinner.',
      },
    },
  },
  args: { children: 'Save changes' },
} satisfies Meta<typeof FormSubmitButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Pending: Story = {
  args: { pending: true },
};

export const Disabled: Story = {
  args: { disabled: true },
};
