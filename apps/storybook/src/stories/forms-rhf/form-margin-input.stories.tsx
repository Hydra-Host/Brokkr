import { FormMarginInput } from '@repo/ui/form/form-margin-input';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormMarginInput',
  component: FormMarginInput,
  parameters: {
    docs: {
      description: {
        component:
          'Percentage input bound via `control`. The user types a percent (0-100, "%" suffix shown) while the form value stays a decimal fraction rounded to 4 places: typing `12.5` stores `0.125`. Input above 100 or non-numeric characters are rejected.',
      },
    },
  },
} satisfies Meta<typeof FormMarginInput>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ margin: 0 }}>
      {({ control }) => (
        <FormMarginInput
          control={control}
          name="margin"
          label="Platform margin"
          description="Applied on top of the provider's base price."
        />
      )}
    </StoryForm>
  ),
};

export const Prefilled: Story = {
  render: () => (
    <StoryForm defaultValues={{ margin: 0.175 }}>
      {({ control }) => (
        <FormMarginInput
          control={control}
          name="margin"
          label="Platform margin"
          description="A stored decimal of 0.175 displays as 17.5%."
        />
      )}
    </StoryForm>
  ),
};

export const ComposedRoundTrip: Story = {
  render: () => (
    <StoryForm defaultValues={{ margin: 0.125 }}>
      {(form) => (
        <>
          <FormMarginInput
            control={form.control}
            name="margin"
            label="Platform margin"
            description="Type a percent and watch the decimal the form actually stores."
          />
          <p className="text-text-muted font-mono text-xs">
            form value (decimal): {JSON.stringify(form.watch('margin'))} → display:{' '}
            {(form.watch('margin') * 100).toFixed(2)}%
          </p>
        </>
      )}
    </StoryForm>
  ),
};
