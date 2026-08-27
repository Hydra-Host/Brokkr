import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Switch } from '@repo/ui/components/switch';
import { Textarea } from '@repo/ui/components/textarea';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Forms/Primitives/Field',
  component: Field,
  argTypes: {
    orientation: {
      control: 'select',
      options: ['vertical', 'horizontal', 'responsive'],
    },
  },
  args: { orientation: 'vertical' },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Vertical: Story = {
  render: (args) => (
    <Field {...args}>
      <FieldLabel htmlFor="cluster-name">Cluster name</FieldLabel>
      <Input id="cluster-name" placeholder="prod-us-east" />
      <FieldDescription>Lowercase letters, digits, and dashes only.</FieldDescription>
    </Field>
  ),
};

export const Horizontal: Story = {
  render: () => (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>Auto-scaling</FieldTitle>
        <FieldDescription>Add capacity when utilization exceeds 80%.</FieldDescription>
      </FieldContent>
      <Switch id="auto-scaling" defaultChecked />
    </Field>
  ),
};

export const Responsive: Story = {
  render: () => (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>IPMI access</FieldTitle>
          <FieldDescription>
            Stacks vertically below the @md container breakpoint, switches to a row above it. Resize the canvas to see
            it flip.
          </FieldDescription>
        </FieldContent>
        <Switch id="ipmi-access" />
      </Field>
    </FieldGroup>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Field data-invalid="true">
      <FieldLabel htmlFor="ipv4">IPv4 address</FieldLabel>
      <Input id="ipv4" defaultValue="300.10.0.1" aria-invalid />
      <FieldError errors={[{ message: 'Must be a valid IPv4 address.' }]} />
    </Field>
  ),
};

export const GroupedForm: Story = {
  render: () => (
    <FieldGroup>
      <FieldSet>
        <FieldLegend>Device details</FieldLegend>
        <FieldDescription>Shown to your team in the device inventory.</FieldDescription>
        <Field>
          <FieldLabel htmlFor="device-name">Device name</FieldLabel>
          <Input id="device-name" placeholder="gpu-node-01" />
        </Field>
        <Field>
          <FieldLabel htmlFor="device-notes">Notes</FieldLabel>
          <Textarea id="device-notes" placeholder="Rack, PDU, cabling…" />
        </Field>
      </FieldSet>
      <FieldSeparator>Networking</FieldSeparator>
      <FieldSet>
        <Field>
          <FieldLabel htmlFor="device-ip">Primary IPv4</FieldLabel>
          <Input id="device-ip" placeholder="10.0.4.21" />
          <FieldDescription>Must be inside the cluster subnet.</FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle>Public endpoint</FieldTitle>
            <FieldDescription>Expose this device on a public IP.</FieldDescription>
          </FieldContent>
          <Switch id="public-endpoint" />
        </Field>
      </FieldSet>
    </FieldGroup>
  ),
};
