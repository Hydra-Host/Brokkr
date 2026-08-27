import { FormCombobox } from '@repo/ui/form/form-combobox';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { comboboxOptions } from '../../lib/fixtures';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormCombobox',
  component: FormCombobox,
  parameters: {
    docs: {
      description: {
        component:
          'Searchable single-select bound via `control`. Wraps the `Combobox` primitive, so it inherits its props (`options`, required `placeholder`, `emptyMessage`, ...). Selecting the already-selected option clears the value back to `""`.',
      },
    },
  },
} satisfies Meta<typeof FormCombobox>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ region: '' }}>
      {({ control }) => (
        <FormCombobox
          control={control}
          name="region"
          label="Region"
          placeholder="Search regions..."
          options={comboboxOptions}
          description="Type to filter by name or location."
        />
      )}
    </StoryForm>
  ),
};

export const Preselected: Story = {
  render: () => (
    <StoryForm defaultValues={{ region: 'eu-central-1' }}>
      {({ control }) => (
        <FormCombobox
          control={control}
          name="region"
          label="Region"
          placeholder="Search regions..."
          options={comboboxOptions}
        />
      )}
    </StoryForm>
  ),
};

export const ComposedWatchedValue: Story = {
  render: () => (
    <StoryForm defaultValues={{ region: 'us-east-1' }}>
      {(form) => (
        <>
          <FormCombobox
            control={form.control}
            name="region"
            label="Region"
            placeholder="Search regions..."
            options={comboboxOptions}
            description="Re-selecting the current region clears it."
          />
          <p className="text-text-muted font-mono text-xs">form value: {JSON.stringify(form.watch('region'))}</p>
        </>
      )}
    </StoryForm>
  ),
};
