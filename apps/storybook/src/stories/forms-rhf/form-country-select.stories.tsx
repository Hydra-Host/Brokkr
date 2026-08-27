import { FormCountrySelect } from '@repo/ui/form/form-country-select';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormCountrySelect',
  component: FormCountrySelect,
  parameters: {
    docs: {
      description: {
        component:
          'Country dropdown bound via `control`. A thin wrapper over `FormSelect` that ships its own `COUNTRY_OPTIONS` list (also exported); the form value is an ISO-3166 alpha-2 code like `"US"`. `label` defaults to "Country".',
      },
    },
  },
} satisfies Meta<typeof FormCountrySelect>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ country: '' }}>
      {({ control }) => <FormCountrySelect control={control} name="country" description="Used for tax residency." />}
    </StoryForm>
  ),
};

export const Preselected: Story = {
  render: () => (
    <StoryForm defaultValues={{ country: 'BR' }}>
      {({ control }) => <FormCountrySelect control={control} name="country" label="Country of incorporation" />}
    </StoryForm>
  ),
};

export const ComposedWatchedValue: Story = {
  render: () => (
    <StoryForm defaultValues={{ country: 'US' }}>
      {(form) => (
        <>
          <FormCountrySelect control={form.control} name="country" />
          <p className="text-text-muted font-mono text-xs">
            form value (alpha-2): {JSON.stringify(form.watch('country'))}
          </p>
        </>
      )}
    </StoryForm>
  ),
};
