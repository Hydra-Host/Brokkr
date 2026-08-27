import { FilterBuilder } from '@repo/ui/components/filter-builder';
import type { ActiveFilter, FilterFieldConfig, FilterOperator } from '@repo/ui/hooks/use-filters';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

// One field per FilterFieldType: string, number, enum (options), date.
const fields: FilterFieldConfig[] = [
  { field: 'hostname', label: 'Hostname', type: 'string' },
  { field: 'gpuCount', label: 'GPU count', type: 'number' },
  {
    field: 'status',
    label: 'Status',
    type: 'enum',
    options: ['online', 'offline', 'provisioning', 'decommissioned'],
  },
  { field: 'createdAt', label: 'Created', type: 'date' },
];

function ControlledFilterBuilder({ initialFilters = [] }: { initialFilters?: ActiveFilter[] }) {
  const [filters, setFilters] = useState<ActiveFilter[]>(initialFilters);

  const addFilter = (field: string, operator: FilterOperator, value: string) =>
    setFilters((prev) => [...prev, { id: `${field}-${operator}-${value}`, field, operator, value }]);

  return (
    <div className="w-[640px] space-y-4">
      <FilterBuilder
        fields={fields}
        activeFilters={filters}
        onAdd={addFilter}
        onRemove={(id) => setFilters((prev) => prev.filter((filter) => filter.id !== id))}
        onClear={() => setFilters([])}
      />
      <pre className="text-text-muted font-mono text-xs">{JSON.stringify(filters, null, 2)}</pre>
    </div>
  );
}

const meta = {
  title: 'Data Display/FilterBuilder',
  component: FilterBuilder,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof FilterBuilder>;

export default meta;
type Story = StoryObj<typeof ControlledFilterBuilder>;

export const Default: Story = {
  render: () => <ControlledFilterBuilder />,
};

export const WithActiveFilters: Story = {
  render: () => (
    <ControlledFilterBuilder
      initialFilters={[
        {
          id: 'status-eq-online',
          field: 'status',
          operator: 'eq',
          value: 'online',
        },
        {
          id: 'gpuCount-gte-8',
          field: 'gpuCount',
          operator: 'gte',
          value: '8',
        },
      ]}
    />
  ),
};
