import { FormSelect } from '@repo/ui/form/form-select';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { selectOptions } from '../../lib/fixtures';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormSelect',
  component: FormSelect,
  parameters: {
    docs: {
      description: {
        component:
          'Single-value select bound via `control`. Takes `options: SelectOption[]` (`{ label, value, disabled? }`). `clearable` swaps the trigger content for a custom layout with an inline clear button that resets the value to `""`.',
      },
    },
  },
} satisfies Meta<typeof FormSelect>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ os: '' }}>
      {({ control }) => (
        <FormSelect
          control={control}
          name="os"
          label="Operating system"
          placeholder="Choose an OS image"
          options={selectOptions}
          description="Installed on first boot."
        />
      )}
    </StoryForm>
  ),
};

export const Clearable: Story = {
  render: () => (
    <StoryForm defaultValues={{ os: 'talos' }}>
      {({ control }) => (
        <FormSelect
          control={control}
          name="os"
          label="Operating system"
          placeholder="Choose an OS image"
          options={selectOptions}
          clearable
          description="The X inside the trigger clears the selection."
        />
      )}
    </StoryForm>
  ),
};

export const Preselected: Story = {
  render: () => (
    <StoryForm defaultValues={{ os: 'ubuntu-24.04' }}>
      {({ control }) => <FormSelect control={control} name="os" label="Operating system" options={selectOptions} />}
    </StoryForm>
  ),
};

export const Disabled: Story = {
  render: () => (
    <StoryForm defaultValues={{ os: 'debian-13' }}>
      {({ control }) => (
        <FormSelect
          control={control}
          name="os"
          label="Operating system"
          options={selectOptions}
          disabled
          description="Locked while the server is provisioning."
        />
      )}
    </StoryForm>
  ),
};

export const ComposedWatchedValue: Story = {
  render: () => (
    <StoryForm defaultValues={{ os: '' }}>
      {(form) => (
        <>
          <FormSelect
            control={form.control}
            name="os"
            label="Operating system"
            placeholder="Choose an OS image"
            options={selectOptions}
            clearable
          />
          <p className="text-text-muted font-mono text-xs">form value: {JSON.stringify(form.watch('os'))}</p>
        </>
      )}
    </StoryForm>
  ),
};
