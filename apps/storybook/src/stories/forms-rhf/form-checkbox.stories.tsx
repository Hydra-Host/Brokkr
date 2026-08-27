import { zodResolver } from '@hookform/resolvers/zod';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { z } from 'zod';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormCheckbox',
  component: FormCheckbox,
  parameters: {
    docs: {
      description: {
        component:
          'Checkbox bound via `control`. The `label` and optional `tooltip` render inline with the box; `description` renders below as field help text.',
      },
    },
  },
} satisfies Meta<typeof FormCheckbox>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ autoRenew: true }}>
      {({ control }) => <FormCheckbox control={control} name="autoRenew" label="Auto-renew subscription" />}
    </StoryForm>
  ),
};

export const WithDescription: Story = {
  render: () => (
    <StoryForm defaultValues={{ alerts: false }}>
      {({ control }) => (
        <FormCheckbox
          control={control}
          name="alerts"
          label="Email me on device alerts"
          tooltip="Alerts fire when a device goes offline or thermals exceed thresholds."
          description="One digest per hour at most; critical alerts send immediately."
        />
      )}
    </StoryForm>
  ),
};

const termsSchema = z.object({
  acceptTerms: z.boolean().refine((v) => v, {
    message: 'You must accept the terms to continue',
  }),
  marketingOptIn: z.boolean(),
});

export const ComposedTermsAcceptance: Story = {
  render: () => (
    <StoryForm defaultValues={{ acceptTerms: false, marketingOptIn: true }} resolver={zodResolver(termsSchema)}>
      {({ control }) => (
        <>
          <FormCheckbox
            control={control}
            name="acceptTerms"
            label="I agree to the Terms of Service"
            description="Required. Submit unchecked to see the error."
          />
          <FormCheckbox control={control} name="marketingOptIn" label="Send me product updates" />
          <FormSubmitButton>Create account</FormSubmitButton>
        </>
      )}
    </StoryForm>
  ),
};
