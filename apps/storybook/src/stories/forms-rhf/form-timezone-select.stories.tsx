import { FormTimezoneSelect } from '@repo/ui/form/form-timezone-select';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormTimezoneSelect',
  component: FormTimezoneSelect,
  parameters: {
    docs: {
      description: {
        component:
          'Timezone dropdown bound via `control`. A thin wrapper over `FormSelect` whose options come from `Intl.supportedValuesOf("timeZone")` (exported as `TIMEZONE_OPTIONS`), so the list matches the runtime ICU data. The form value is an IANA zone id like `"America/Sao_Paulo"`. `label` defaults to "Timezone".',
      },
    },
  },
} satisfies Meta<typeof FormTimezoneSelect>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ timezone: '' }}>
      {({ control }) => (
        <FormTimezoneSelect
          control={control}
          name="timezone"
          description="Maintenance windows are scheduled in this zone."
        />
      )}
    </StoryForm>
  ),
};

export const Preselected: Story = {
  render: () => (
    <StoryForm defaultValues={{ timezone: 'America/Sao_Paulo' }}>
      {({ control }) => <FormTimezoneSelect control={control} name="timezone" label="Billing timezone" />}
    </StoryForm>
  ),
};

export const ComposedWatchedValue: Story = {
  render: () => (
    <StoryForm defaultValues={{ timezone: 'Europe/Berlin' }}>
      {(form) => (
        <>
          <FormTimezoneSelect control={form.control} name="timezone" />
          <p className="text-text-muted font-mono text-xs">
            form value (IANA id): {JSON.stringify(form.watch('timezone'))}
          </p>
        </>
      )}
    </StoryForm>
  ),
};
