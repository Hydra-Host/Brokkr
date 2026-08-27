import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  SelectWrapper,
} from '@repo/ui/components/select';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { selectOptions } from '../../lib/fixtures';

const osItems = Object.fromEntries(selectOptions.map((option) => [option.value, option.label]));

const meta = {
  title: 'Forms/Primitives/Select',
  component: Select,
  argTypes: {
    disabled: { control: 'boolean' },
  },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Select {...args} items={osItems} defaultValue="ubuntu-24.04">
      <SelectTrigger>
        <SelectValue placeholder="Select an operating system" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Linux</SelectLabel>
          <SelectItem value="ubuntu-24.04">Ubuntu 24.04 LTS</SelectItem>
          <SelectItem value="debian-13">Debian 13</SelectItem>
          <SelectItem value="rocky-10">Rocky Linux 10</SelectItem>
          <SelectItem value="talos">Talos</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Windows</SelectLabel>
          <SelectItem value="windows-2025">Windows Server 2025</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};

export const WithWrapper: Story = {
  render: () => (
    <SelectWrapper id="os" label="Operating system" tooltip="The image flashed during provisioning.">
      <Select items={osItems}>
        <SelectTrigger id="os">
          <SelectValue placeholder="Select an operating system" />
        </SelectTrigger>
        <SelectContent>
          {selectOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SelectWrapper>
  ),
};

export const WithError: Story = {
  render: () => (
    <SelectWrapper id="os-error" label="Operating system" error="An operating system is required.">
      <Select items={osItems}>
        <SelectTrigger id="os-error" error="An operating system is required.">
          <SelectValue placeholder="Select an operating system" />
        </SelectTrigger>
        <SelectContent>
          {selectOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SelectWrapper>
  ),
};

export const HideCorners: Story = {
  render: () => (
    <Select items={osItems} defaultValue="talos">
      <SelectTrigger hideCorners>
        <SelectValue placeholder="Select an operating system" />
      </SelectTrigger>
      <SelectContent>
        {selectOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Select items={osItems} defaultValue="debian-13" disabled>
      <SelectTrigger>
        <SelectValue placeholder="Select an operating system" />
      </SelectTrigger>
      <SelectContent>
        {selectOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ),
};
