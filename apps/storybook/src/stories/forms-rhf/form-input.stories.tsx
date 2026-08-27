import { zodResolver } from '@hookform/resolvers/zod';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { z } from 'zod';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormInput',
  component: FormInput,
  parameters: {
    docs: {
      description: {
        component: 'Text input bound to react-hook-form via an explicit `control` prop. No `FormProvider` is required.',
      },
    },
  },
} satisfies Meta<typeof FormInput>;

export default meta;
// Render-only stories can't satisfy StoryObj<typeof meta> — FormInput's
// required control/name props come from the StoryForm harness, not args.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ email: '' }}>
      {({ control }) => (
        <FormInput
          control={control}
          name="email"
          label="Email address"
          placeholder="ada@example.com"
          description="We only use this for billing notifications."
        />
      )}
    </StoryForm>
  ),
};

const hostnameSchema = z.object({
  hostname: z
    .string()
    .min(3, 'Hostname must be at least 3 characters')
    .regex(/^[a-z0-9-]+$/, 'Lowercase letters, digits, and dashes only'),
});

export const WithValidation: Story = {
  render: () => (
    <StoryForm defaultValues={{ hostname: '' }} resolver={zodResolver(hostnameSchema)}>
      {({ control }) => (
        <>
          <FormInput
            control={control}
            name="hostname"
            label="Hostname"
            placeholder="edge-01"
            description="Submit empty or with capitals to trigger validation."
          />
          <FormSubmitButton>Save</FormSubmitButton>
        </>
      )}
    </StoryForm>
  ),
};

export const ComposedProfileForm: Story = {
  render: () => (
    <StoryForm defaultValues={{ firstName: 'Ada', lastName: 'Lovelace', company: '' }}>
      {({ control }) => (
        <>
          <div className="grid grid-cols-2 gap-4">
            <FormInput control={control} name="firstName" label="First name" />
            <FormInput control={control} name="lastName" label="Last name" />
          </div>
          <FormInput
            control={control}
            name="company"
            label="Company"
            labelRight={<span className="text-text-muted text-xs">Optional</span>}
          />
          <FormSubmitButton>Save profile</FormSubmitButton>
        </>
      )}
    </StoryForm>
  ),
};
