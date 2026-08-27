import { Label } from '@repo/ui/components/label';
import { Switch } from '@repo/ui/components/switch';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

const meta = {
  title: 'Forms/Primitives/Switch',
  component: Switch,
  argTypes: {
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { defaultChecked: true },
};

const ControlledDemo = () => {
  const [enabled, setEnabled] = useState(false);
  return (
    <div className="flex items-center gap-3">
      <Switch id="maintenance" checked={enabled} onCheckedChange={setEnabled} />
      <Label htmlFor="maintenance" className="text-text-primary normal-case">
        Maintenance mode {enabled ? 'on' : 'off'}
      </Label>
    </div>
  );
};

export const WithLabel: Story = {
  render: () => <ControlledDemo />,
};

export const Disabled: Story = {
  args: { disabled: true, defaultChecked: true },
};

const SETTINGS = [
  {
    id: 'auto-provision',
    label: 'Auto-provision',
    description: 'Provision devices as soon as payment settles.',
    defaultChecked: true,
  },
  {
    id: 'email-alerts',
    label: 'Email alerts',
    description: 'Send an email when a device goes offline.',
    defaultChecked: true,
  },
  {
    id: 'spot-reclaim',
    label: 'Spot reclaim notices',
    description: 'Notify 2 minutes before spot capacity is reclaimed.',
    defaultChecked: false,
  },
];

export const SettingsPanel: Story = {
  render: () => (
    <div className="border-border-dim divide-border-dim flex w-96 flex-col divide-y border">
      {SETTINGS.map((setting) => (
        <div key={setting.id} className="flex items-center justify-between gap-4 p-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor={setting.id} className="text-text-primary normal-case">
              {setting.label}
            </Label>
            <p className="text-text-dim text-sm">{setting.description}</p>
          </div>
          <Switch id={setting.id} defaultChecked={setting.defaultChecked} />
        </div>
      ))}
    </div>
  ),
};
