import { zodResolver } from '@hookform/resolvers/zod';
import { FormPasswordInput, zodValidatePasswordComplexity } from '@repo/ui/form/form-password-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { z } from 'zod';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormPasswordInput',
  component: FormPasswordInput,
  parameters: {
    docs: {
      description: {
        component:
          'Password field bound via `control` with a show/hide toggle. `showStrengthChecklist` opens a live requirements tooltip while focused; the module also exports `zodValidatePasswordComplexity()` so the resolver enforces the same rules (12+ chars, 3 of 4 character classes).',
      },
    },
  },
} satisfies Meta<typeof FormPasswordInput>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ password: '' }}>
      {({ control }) => (
        <FormPasswordInput
          control={control}
          name="password"
          label="Password"
          placeholder="Enter your password"
          description="The eye button toggles visibility."
        />
      )}
    </StoryForm>
  ),
};

const passwordSchema = z.object({
  password: zodValidatePasswordComplexity(),
});

export const WithStrengthChecklist: Story = {
  render: () => (
    <StoryForm defaultValues={{ password: '' }} resolver={zodResolver(passwordSchema)}>
      {({ control }) => (
        <>
          <FormPasswordInput
            control={control}
            name="password"
            label="New password"
            showStrengthChecklist
            description="Focus the field to see the live checklist; submit a weak password to see the resolver error."
          />
          <FormSubmitButton>Set password</FormSubmitButton>
        </>
      )}
    </StoryForm>
  ),
};

const changePasswordSchema = z
  .object({
    newPassword: zodValidatePasswordComplexity(),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const ComposedChangePassword: Story = {
  render: () => (
    <StoryForm defaultValues={{ newPassword: '', confirmPassword: '' }} resolver={zodResolver(changePasswordSchema)}>
      {({ control }) => (
        <>
          <FormPasswordInput control={control} name="newPassword" label="New password" showStrengthChecklist />
          <FormPasswordInput control={control} name="confirmPassword" label="Confirm password" />
          <FormSubmitButton>Change password</FormSubmitButton>
        </>
      )}
    </StoryForm>
  ),
};
