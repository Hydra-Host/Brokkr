import { Badge } from '@repo/ui/components/badge';
import { DataTable, DataTableSelectColumn, DataTableSortHeader } from '@repo/ui/components/data-table';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ColumnDef } from '@tanstack/react-table';

import { people, type Person } from '../../lib/fixtures';

const statusVariant = {
  active: 'online',
  invited: 'warning',
  disabled: 'offline',
} as const;

// Pin the generic so meta args typecheck against Person rows.
const PersonDataTable = DataTable<Person, unknown>;

const columns: ColumnDef<Person>[] = [
  DataTableSelectColumn as ColumnDef<Person>,
  {
    accessorKey: 'name',
    header: ({ column }) => <DataTableSortHeader column={column} label="Name" />,
  },
  { accessorKey: 'email', header: 'Email', size: 220 },
  {
    accessorKey: 'role',
    header: 'Role',
    filterFn: (row, id, value: string[]) => value.length === 0 || value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    filterFn: (row, id, value: string[]) => value.length === 0 || value.includes(row.getValue(id)),
    cell: ({ row }) => (
      <Badge size="sm" variant={statusVariant[row.original.status]}>
        {row.original.status}
      </Badge>
    ),
  },
];

// DataTable persists search/filters/page size to localStorage keyed by `name`,
// so every story gets its own unique name.
const meta = {
  title: 'Data Display/DataTable',
  component: PersonDataTable,
  parameters: { layout: 'padded' },
  args: {
    columns,
    data: people,
    name: 'sb-dt-default',
    enablePagination: true,
  },
} satisfies Meta<typeof PersonDataTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithFilters: Story = {
  args: {
    name: 'sb-dt-filters',
    searchableColumns: [
      { id: 'name', title: 'Name' },
      { id: 'email', title: 'Email' },
    ],
    filters: [
      {
        id: 'role',
        label: 'Role',
        options: [
          { label: 'Admin', value: 'Admin' },
          { label: 'Member', value: 'Member' },
          { label: 'Viewer', value: 'Viewer' },
        ],
      },
      {
        id: 'status',
        label: 'Status',
        options: [
          { label: 'Active', value: 'active' },
          { label: 'Invited', value: 'invited' },
          { label: 'Disabled', value: 'disabled' },
        ],
      },
    ],
  },
};

export const Empty: Story = {
  args: {
    name: 'sb-dt-empty',
    data: [],
    emptyMessage: 'No members yet. Invite someone to get started.',
  },
};
