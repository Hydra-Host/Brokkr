import { Badge } from '@repo/ui/components/badge';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/table';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { people } from '../../lib/fixtures';

const rows = people.slice(0, 6);

const meta = {
  title: 'Data Display/Table',
  component: Table,
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Table containerClassName="w-[640px]">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((person) => (
          <TableRow key={person.id}>
            <TableCell className="text-text-primary">{person.name}</TableCell>
            <TableCell>{person.email}</TableCell>
            <TableCell>{person.role}</TableCell>
            <TableCell>
              <Badge
                size="sm"
                variant={person.status === 'active' ? 'online' : person.status === 'invited' ? 'warning' : 'offline'}
              >
                {person.status}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

export const WithCaptionAndFooter: Story = {
  render: () => (
    <Table containerClassName="w-[640px]">
      <TableCaption>Team members and their seat allocation.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Role</TableHead>
          <TableHead className="text-right">Seats</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((person, index) => (
          <TableRow key={person.id}>
            <TableCell className="text-text-primary">{person.name}</TableCell>
            <TableCell>{person.role}</TableCell>
            <TableCell className="text-right">{(index % 3) + 1}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={2} className="text-primary-foreground">
            Total
          </TableCell>
          <TableCell className="text-primary-foreground text-right">
            {rows.reduce((sum, _, index) => sum + ((index % 3) + 1), 0)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
};
