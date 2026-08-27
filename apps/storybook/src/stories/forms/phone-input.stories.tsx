import { PhoneInput } from '@repo/ui/components/phone-input';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

const meta = {
  title: 'Forms/Primitives/PhoneInput',
  component: PhoneInput,
  argTypes: {
    disabled: { control: 'boolean' },
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PhoneInput>;

export default meta;
type Story = StoryObj<typeof meta>;

const ControlledDemo = () => {
  const [value, setValue] = useState('');
  return (
    <div className="flex flex-col gap-2">
      <PhoneInput
        id="phone"
        label="Phone number"
        placeholder="Enter a phone number"
        value={value}
        onChange={setValue}
      />
      <p className="text-text-dim font-mono text-xs">E.164 value: {value || '—'}</p>
    </div>
  );
};

export const Default: Story = {
  render: () => <ControlledDemo />,
};

export const WithDefaultCountry: Story = {
  render: () => (
    <PhoneInput
      id="phone-br"
      label="Phone number"
      defaultCountry="BR"
      placeholder="11 91234 5678"
      onChange={() => {}}
    />
  ),
};

export const Disabled: Story = {
  render: () => (
    <PhoneInput id="phone-disabled" label="Phone number" value="+14155552671" onChange={() => {}} disabled />
  ),
};
