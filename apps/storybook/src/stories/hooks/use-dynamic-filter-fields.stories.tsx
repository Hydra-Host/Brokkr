import { useDynamicFilterFields, type DynamicFilterFieldConfig } from '@repo/ui/hooks/use-dynamic-filter-fields';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { people, type Person } from '../../lib/fixtures';

const fieldConfigs: DynamicFilterFieldConfig<Person>[] = [
  { field: 'name', label: 'Name', type: 'string' },
  { field: 'role', label: 'Role', type: 'enum', accessor: (row) => row.role },
  {
    field: 'status',
    label: 'Status',
    type: 'enum',
    accessor: (row) => row.status,
  },
  { field: 'createdAt', label: 'Created', type: 'date' },
];

function DynamicFilterFieldsDemo() {
  const fields = useDynamicFilterFields(fieldConfigs, people);

  return (
    <div className="border-border-dim bg-bg-secondary flex w-[480px] flex-col gap-4 border p-6 font-mono">
      <code className="text-text-muted text-xs">useDynamicFilterFields(fields, data) · {people.length} rows</code>
      <div className="flex flex-col gap-3">
        {fields.map((field) => (
          <div key={field.field} className="flex flex-col gap-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-accent">{field.label}</span>
              <span className="text-text-dim">
                field: {field.field} · type: {field.type}
              </span>
            </div>
            <span className="text-text-muted break-all">
              options: {field.options ? JSON.stringify(field.options) : '(none)'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const meta = {
  title: 'Hooks/useDynamicFilterFields',
  component: DynamicFilterFieldsDemo,
  parameters: {
    docs: {
      description: {
        component:
          'Turns `DynamicFilterFieldConfig` entries into plain `FilterFieldConfig`s for `useFilters` / ' +
          '`FilterBuilder`. Fields with an `accessor` get their `options` derived from the distinct, ' +
          'sorted values found in `data`; fields without one pass through unchanged. Here the enum ' +
          'options are derived from the shared `people` fixture.',
      },
    },
  },
} satisfies Meta<typeof DynamicFilterFieldsDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
