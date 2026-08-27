import { Label } from '@repo/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@repo/ui/components/radio-group';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Forms/Primitives/RadioGroup',
  component: RadioGroup,
  argTypes: {
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <RadioGroup {...args} defaultValue="ubuntu-24.04">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="ubuntu-24.04" id="os-ubuntu" />
        <Label htmlFor="os-ubuntu" className="text-text-primary normal-case">
          Ubuntu 24.04 LTS
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="debian-13" id="os-debian" />
        <Label htmlFor="os-debian" className="text-text-primary normal-case">
          Debian 13
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="talos" id="os-talos" />
        <Label htmlFor="os-talos" className="text-text-primary normal-case">
          Talos
        </Label>
      </div>
    </RadioGroup>
  ),
};

export const Horizontal: Story = {
  render: () => (
    <RadioGroup defaultValue="monthly" className="flex flex-row gap-6">
      {['hourly', 'monthly', 'yearly'].map((term) => (
        <div key={term} className="flex items-center gap-2">
          <RadioGroupItem value={term} id={`term-${term}`} />
          <Label htmlFor={`term-${term}`} className="text-text-primary normal-case">
            {term}
          </Label>
        </div>
      ))}
    </RadioGroup>
  ),
};

const TIERS = [
  {
    value: 'on-demand',
    label: 'On-demand',
    description: 'Pay by the hour, cancel anytime.',
  },
  {
    value: 'reserved',
    label: 'Reserved',
    description: 'Commit for 12 months at a 40% discount.',
  },
  {
    value: 'spot',
    label: 'Spot',
    description: 'Cheapest capacity, may be reclaimed with 2 minutes notice.',
  },
];

export const WithDescriptions: Story = {
  render: () => (
    <RadioGroup defaultValue="reserved" className="w-96 gap-4">
      {TIERS.map((tier) => (
        <div key={tier.value} className="flex items-start gap-3">
          <RadioGroupItem value={tier.value} id={`tier-${tier.value}`} className="mt-0.5" />
          <div className="flex flex-col gap-1">
            <Label htmlFor={`tier-${tier.value}`} className="text-text-primary normal-case">
              {tier.label}
            </Label>
            <p className="text-text-dim text-sm">{tier.description}</p>
          </div>
        </div>
      ))}
    </RadioGroup>
  ),
};

export const DisabledItem: Story = {
  render: () => (
    <RadioGroup defaultValue="us-east-1">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="us-east-1" id="region-east" />
        <Label htmlFor="region-east" className="text-text-primary normal-case">
          us-east-1 · Ashburn
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="eu-central-1" id="region-eu" disabled />
        <Label htmlFor="region-eu" className="text-text-dim normal-case">
          eu-central-1 · Frankfurt (no capacity)
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="ap-southeast-1" id="region-ap" />
        <Label htmlFor="region-ap" className="text-text-primary normal-case">
          ap-southeast-1 · Singapore
        </Label>
      </div>
    </RadioGroup>
  ),
};
