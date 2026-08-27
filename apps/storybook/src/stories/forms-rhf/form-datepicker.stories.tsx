import { FormDatePicker } from '@repo/ui/form/form-datepicker';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormDatePicker',
  component: FormDatePicker,
  parameters: {
    docs: {
      description: {
        component:
          'Calendar popover bound via `control`. The field value is an ISO string (`Date.toISOString()`), or `""` when cleared. Plain mode snaps to midnight and closes on pick; `withTime` keeps the popover open and adds a time input.',
      },
    },
  },
} satisfies Meta<typeof FormDatePicker>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ decommissionDate: '' }}>
      {({ control }) => (
        <FormDatePicker
          control={control}
          name="decommissionDate"
          label="Decommission date"
          description="The server drains workloads the night before."
        />
      )}
    </StoryForm>
  ),
};

export const WithTime: Story = {
  render: () => (
    <StoryForm defaultValues={{ maintenanceStart: '' }}>
      {({ control }) => (
        <FormDatePicker
          control={control}
          name="maintenanceStart"
          label="Maintenance window start"
          withTime
          placeholder="Pick date and time"
          description="Pick a day, then set the time and press Done."
        />
      )}
    </StoryForm>
  ),
};

const today = new Date();
const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

export const MinMaxWindow: Story = {
  render: () => (
    <StoryForm defaultValues={{ reservationDate: '' }}>
      {({ control }) => (
        <FormDatePicker
          control={control}
          name="reservationDate"
          label="Reservation date"
          minDate={today}
          maxDate={in30Days}
          description="Only the next 30 days are selectable."
        />
      )}
    </StoryForm>
  ),
};

export const ComposedWatchedValue: Story = {
  render: () => (
    <StoryForm defaultValues={{ maintenanceStart: '' }}>
      {(form) => (
        <>
          <FormDatePicker control={form.control} name="maintenanceStart" label="Maintenance window start" withTime />
          <p className="text-text-muted font-mono text-xs">
            form value (ISO): {JSON.stringify(form.watch('maintenanceStart'))}
          </p>
        </>
      )}
    </StoryForm>
  ),
};
