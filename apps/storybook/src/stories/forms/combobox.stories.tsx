import { Combobox } from '@repo/ui/components/combobox';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { comboboxOptions } from '../../lib/fixtures';

const meta = {
  title: 'Forms/Primitives/Combobox',
  component: Combobox,
  argTypes: {
    disabled: { control: 'boolean' },
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Combobox>;

export default meta;
type Story = StoryObj<typeof meta>;

const ControlledDemo = ({ initialValue = '' }: { initialValue?: string }) => {
  const [value, setValue] = useState(initialValue);
  return <Combobox options={comboboxOptions} value={value} setValue={setValue} placeholder="Select a region…" />;
};

export const Default: Story = {
  args: {
    options: comboboxOptions,
    value: undefined,
    setValue: () => {},
    placeholder: 'Select a region…',
  },
  render: () => <ControlledDemo />,
};

export const Preselected: Story = {
  args: {
    options: comboboxOptions,
    value: 'eu-central-1',
    setValue: () => {},
    placeholder: 'Select a region…',
  },
  render: () => <ControlledDemo initialValue="eu-central-1" />,
};

const ServerSearchDemo = () => {
  const [value, setValue] = useState('');
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState(comboboxOptions);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => {
      setOptions(comboboxOptions.filter((option) => option.label.toLowerCase().includes(search.toLowerCase())));
      setLoading(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <div className="flex flex-col gap-2">
      <Combobox
        options={options}
        value={value}
        setValue={setValue}
        placeholder="Search regions…"
        searchValue={search}
        onSearchChange={setSearch}
        shouldFilter={false}
        emptyMessage={loading ? 'Searching…' : 'No regions found.'}
      />
      <p className="text-text-dim font-mono text-xs">
        Options are filtered server-side with a simulated 400ms latency.
      </p>
    </div>
  );
};

export const ServerSearch: Story = {
  args: {
    options: comboboxOptions,
    value: undefined,
    setValue: () => {},
    placeholder: 'Search regions…',
  },
  render: () => <ServerSearchDemo />,
};

export const Disabled: Story = {
  args: {
    options: comboboxOptions,
    value: 'us-east-1',
    setValue: () => {},
    placeholder: 'Select a region…',
    disabled: true,
  },
};
