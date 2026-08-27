import { FormMoneyInput } from '@repo/ui/form/form-money-input';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormMoneyInput',
  component: FormMoneyInput,
  parameters: {
    docs: {
      description: {
        component:
          'USD amount input bound via `control`. The form value is an integer in cents; the input displays a formatted dollar string and parses typed digits back to cents. With `externalValue` set, the component becomes display-controlled and only reports through `onValueChange` (the form field is not written).',
      },
    },
  },
} satisfies Meta<typeof FormMoneyInput>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ hourlyPriceCents: 0 }}>
      {(form) => (
        <>
          <FormMoneyInput
            control={form.control}
            name="hourlyPriceCents"
            label="Hourly price"
            description="Type digits; they fill from the cents place."
          />
          <p className="text-text-muted font-mono text-xs">
            form value (cents): {JSON.stringify(form.watch('hourlyPriceCents'))}
          </p>
        </>
      )}
    </StoryForm>
  ),
};

export const Prefilled: Story = {
  render: () => (
    <StoryForm defaultValues={{ hourlyPriceCents: 12_999 }}>
      {(form) => (
        <>
          <FormMoneyInput
            control={form.control}
            name="hourlyPriceCents"
            label="Hourly price"
            description="Default value of 12999 cents renders as $129.99."
          />
          <p className="text-text-muted font-mono text-xs">
            form value (cents): {JSON.stringify(form.watch('hourlyPriceCents'))}
          </p>
        </>
      )}
    </StoryForm>
  ),
};

export const Disabled: Story = {
  render: () => (
    <StoryForm defaultValues={{ hourlyPriceCents: 45_000 }}>
      {({ control }) => (
        <FormMoneyInput
          control={control}
          name="hourlyPriceCents"
          label="Hourly price"
          disabled
          description="Locked while a repricing job is running."
        />
      )}
    </StoryForm>
  ),
};
