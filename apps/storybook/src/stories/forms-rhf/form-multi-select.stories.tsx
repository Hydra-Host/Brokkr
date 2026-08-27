import { FormMultiSelect } from '@repo/ui/form/form-multi-select';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { multiSelectGroups } from '../../lib/fixtures';
import { StoryForm } from '../../lib/rhf';

const flatOptions = multiSelectGroups.flatMap((group) => group.options);

const meta = {
  title: 'Forms/React Hook Form/FormMultiSelect',
  component: FormMultiSelect,
  parameters: {
    docs: {
      description: {
        component:
          'Multi-value select bound via `control`; the field value is a `string[]`. Pass either flat `options: MultiSelectOption[]` or `groups: MultiSelectOptionGroup[]` (grouped with separators). Selected values render as removable badges in the trigger.',
      },
    },
  },
} satisfies Meta<typeof FormMultiSelect>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ accelerators: [] as string[] }}>
      {({ control }) => (
        <FormMultiSelect
          control={control}
          name="accelerators"
          label="Accelerators"
          placeholder="Select hardware..."
          options={flatOptions}
        />
      )}
    </StoryForm>
  ),
};

export const Grouped: Story = {
  render: () => (
    <StoryForm defaultValues={{ accelerators: [] as string[] }}>
      {({ control }) => (
        <FormMultiSelect
          control={control}
          name="accelerators"
          label="Accelerators"
          placeholder="Select hardware..."
          groups={multiSelectGroups}
        />
      )}
    </StoryForm>
  ),
};

export const Preselected: Story = {
  render: () => (
    <StoryForm defaultValues={{ accelerators: ['h100-sxm', 'epyc-9654'] }}>
      {({ control }) => (
        <FormMultiSelect control={control} name="accelerators" label="Accelerators" groups={multiSelectGroups} />
      )}
    </StoryForm>
  ),
};

export const ComposedWatchedValue: Story = {
  render: () => (
    <StoryForm defaultValues={{ accelerators: ['h200'] }}>
      {(form) => (
        <>
          <FormMultiSelect
            control={form.control}
            name="accelerators"
            label="Accelerators"
            placeholder="Select hardware..."
            groups={multiSelectGroups}
          />
          <p className="text-text-muted font-mono text-xs">form value: {JSON.stringify(form.watch('accelerators'))}</p>
        </>
      )}
    </StoryForm>
  ),
};
