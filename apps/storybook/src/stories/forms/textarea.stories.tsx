import { Textarea } from '@repo/ui/components/textarea';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Forms/Primitives/Textarea',
  component: Textarea,
  args: { placeholder: 'Describe the issue…' },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithLabelAndTooltip: Story = {
  args: {
    name: 'notes',
    label: 'Maintenance notes',
    tooltip: 'Visible to everyone in your organization.',
  },
};

export const WithError: Story = {
  args: {
    name: 'reason',
    label: 'Decommission reason',
    error: 'A reason is required before decommissioning.',
  },
};

export const Disabled: Story = {
  args: {
    defaultValue: 'Read-only audit note from 2026-07-02.',
    disabled: true,
  },
};

export const CustomRows: Story = {
  args: { rows: 8, placeholder: 'Paste your SSH public key…' },
};

export const SupportTicket: Story = {
  render: () => (
    <div className="flex w-96 flex-col gap-4">
      <Textarea
        name="ticket-body"
        label="What happened?"
        tooltip="Include timestamps and device IDs when possible."
        rows={5}
        defaultValue={'gpu-node-07 dropped off the network at 03:12 UTC.\nIPMI still responds; the OS does not.'}
      />
      <p className="text-text-dim font-mono text-xs">Attachments can be added after the ticket is created.</p>
    </div>
  ),
};
