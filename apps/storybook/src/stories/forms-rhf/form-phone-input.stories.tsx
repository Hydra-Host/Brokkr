import { FormPhoneInput } from '@repo/ui/form/form-phone-input';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormPhoneInput',
  component: FormPhoneInput,
  parameters: {
    docs: {
      description: {
        component:
          'International phone input bound via `control` (react-phone-number-input underneath). The form value is an E.164 string like `+14155550132`, or `""` while empty. `defaultCountry` is an ISO-3166 alpha-2 code that pre-picks the country calling code.',
      },
    },
  },
} satisfies Meta<typeof FormPhoneInput>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ phone: '' }}>
      {({ control }) => (
        <FormPhoneInput
          control={control}
          name="phone"
          label="Phone number"
          placeholder="Enter a phone number"
          description="Used for SMS delivery notifications."
        />
      )}
    </StoryForm>
  ),
};

export const PrefilledE164: Story = {
  render: () => (
    <StoryForm defaultValues={{ phone: '+14155550132' }}>
      {({ control }) => (
        <FormPhoneInput
          control={control}
          name="phone"
          label="Phone number"
          description="An E.164 default selects the matching country automatically."
        />
      )}
    </StoryForm>
  ),
};

export const DefaultCountry: Story = {
  render: () => (
    <StoryForm defaultValues={{ phone: '' }}>
      {({ control }) => (
        <FormPhoneInput
          control={control}
          name="phone"
          label="Phone number"
          defaultCountry="BR"
          placeholder="11 96123 4567"
          description="Starts on Brazil (+55) before anything is typed."
        />
      )}
    </StoryForm>
  ),
};

export const ComposedWatchedValue: Story = {
  render: () => (
    <StoryForm defaultValues={{ phone: '' }}>
      {(form) => (
        <>
          <FormPhoneInput control={form.control} name="phone" label="Phone number" defaultCountry="US" />
          <p className="text-text-muted font-mono text-xs">form value (E.164): {JSON.stringify(form.watch('phone'))}</p>
        </>
      )}
    </StoryForm>
  ),
};
