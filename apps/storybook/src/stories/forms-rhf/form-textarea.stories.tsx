import { zodResolver } from '@hookform/resolvers/zod';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { z } from 'zod';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormTextarea',
  component: FormTextarea,
  parameters: {
    docs: {
      description: {
        component:
          'Multi-line text field bound via `control`. Accepts native textarea props (`rows`, `placeholder`, ...) plus `label`, `labelRight`, and `description`.',
      },
    },
  },
} satisfies Meta<typeof FormTextarea>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ notes: '' }}>
      {({ control }) => (
        <FormTextarea
          control={control}
          name="notes"
          label="Maintenance notes"
          placeholder="Describe what changed during the window..."
          description="Visible to everyone in the organization."
          rows={4}
        />
      )}
    </StoryForm>
  ),
};

export const WithLabelRight: Story = {
  render: () => (
    <StoryForm defaultValues={{ bio: '' }}>
      {({ control }) => (
        <FormTextarea
          control={control}
          name="bio"
          label="Bio"
          labelRight={<span className="text-text-muted text-xs">Optional</span>}
          placeholder="A few words about yourself"
          rows={3}
        />
      )}
    </StoryForm>
  ),
};

const incidentSchema = z.object({
  summary: z.string().min(20, 'Give at least 20 characters of detail').max(500, 'Keep it under 500 characters'),
});

export const WithValidation: Story = {
  render: () => (
    <StoryForm defaultValues={{ summary: '' }} resolver={zodResolver(incidentSchema)}>
      {({ control }) => (
        <>
          <FormTextarea
            control={control}
            name="summary"
            label="Incident summary"
            placeholder="What happened?"
            description="Submit with fewer than 20 characters to trigger the error."
            rows={5}
          />
          <FormSubmitButton>File incident</FormSubmitButton>
        </>
      )}
    </StoryForm>
  ),
};

export const ComposedCharacterCount: Story = {
  render: () => (
    <StoryForm defaultValues={{ announcement: 'Scheduled maintenance on Friday.' }}>
      {(form) => (
        <FormTextarea
          control={form.control}
          name="announcement"
          label="Announcement"
          labelRight={
            <span className="text-text-muted font-mono text-xs">{form.watch('announcement').length}/280</span>
          }
          maxLength={280}
          rows={4}
        />
      )}
    </StoryForm>
  ),
};
