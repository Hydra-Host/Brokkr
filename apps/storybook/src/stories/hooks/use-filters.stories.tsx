import { FilterBuilder } from '@repo/ui/components/filter-builder';
import { useFilters, type FilterFieldConfig } from '@repo/ui/hooks/use-filters';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { withRouter } from '../../lib/decorators';

const fields: FilterFieldConfig[] = [
  { field: 'name', label: 'Name', type: 'string' },
  {
    field: 'role',
    label: 'Role',
    type: 'enum',
    options: ['Admin', 'Member', 'Viewer'],
  },
  {
    field: 'status',
    label: 'Status',
    type: 'enum',
    options: ['active', 'invited', 'disabled'],
  },
  { field: 'devices', label: 'Devices', type: 'number' },
  { field: 'createdAt', label: 'Created', type: 'date' },
];

function FiltersDemo() {
  const { activeFilters, addFilter, removeFilter, clearFilters, filtersQueryParam } = useFilters({ fields });

  return (
    <div className="flex w-[560px] flex-col gap-4 font-mono">
      <FilterBuilder
        fields={fields}
        activeFilters={activeFilters}
        onAdd={addFilter}
        onRemove={removeFilter}
        onClear={clearFilters}
      />
      <div className="border-border-dim bg-bg-secondary flex flex-col gap-2 border p-4 text-xs">
        <span className="text-text-dim">?filters= (serialized, {activeFilters.length} active)</span>
        <code className="text-accent break-all">{filtersQueryParam ?? '(none)'}</code>
      </div>
    </div>
  );
}

const meta = {
  title: 'Hooks/useFilters',
  component: FiltersDemo,
  decorators: [withRouter],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Stores structured filters in a single `filters` search param serialized as ' +
          '`field:operator:value|field:operator:value` and returns `addFilter` / `removeFilter` / ' +
          '`clearFilters` plus the serialized `filtersQueryParam` for API calls. Paired here with ' +
          '`FilterBuilder`, which drives the same callbacks — press `:` or click the bar to add a filter. ' +
          'The story runs on an in-memory router, so the readout shows what the URL would carry.',
      },
    },
  },
} satisfies Meta<typeof FiltersDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
