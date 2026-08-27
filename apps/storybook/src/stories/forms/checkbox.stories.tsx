import { Checkbox } from '@repo/ui/components/checkbox';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

const meta = {
  title: 'Forms/Primitives/Checkbox',
  component: Checkbox,
  argTypes: {
    checked: { control: 'select', options: [true, false, 'indeterminate'] },
  },
  args: { label: 'Enable IPMI access' },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { name: 'ipmi', defaultChecked: true },
};

export const WithTooltip: Story = {
  args: {
    name: 'sweep',
    label: 'Auto-sweep funds',
    tooltip: 'Settled balances are swept to the operating account nightly.',
  },
};

const PERMISSIONS = ['billing:read', 'billing:write', 'billing:export'];

const IndeterminateDemo = () => {
  const [checked, setChecked] = useState([true, false, true]);
  const allChecked = checked.every(Boolean);
  const noneChecked = !checked.some(Boolean);
  const parentChecked = allChecked ? true : noneChecked ? false : ('indeterminate' as const);

  return (
    <div className="flex flex-col gap-3">
      <Checkbox
        id="all-billing"
        label="All billing permissions"
        checked={parentChecked}
        onCheckedChange={(next) => setChecked(PERMISSIONS.map(() => next))}
      />
      <div className="border-border-dim flex flex-col gap-2 border-l pl-6">
        {PERMISSIONS.map((permission, index) => (
          <Checkbox
            key={permission}
            id={permission}
            label={permission}
            checked={checked[index]}
            onCheckedChange={(next) => setChecked(checked.map((c, i) => (i === index ? next : c)))}
          />
        ))}
      </div>
    </div>
  );
};

export const Indeterminate: Story = {
  render: () => <IndeterminateDemo />,
};

export const Disabled: Story = {
  args: {
    name: 'locked',
    label: 'Managed by platform',
    disabled: true,
    defaultChecked: true,
  },
};
