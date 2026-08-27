import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/components/avatar';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { people } from '../../lib/fixtures';

// Inline SVG so the story renders without network access.
const AVATAR_DATA_URI = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
    '<rect width="40" height="40" fill="#1c2b3a"/>' +
    '<circle cx="20" cy="15" r="7" fill="#5eead4"/>' +
    '<path d="M6 40a14 14 0 0 1 28 0z" fill="#5eead4"/>' +
    '</svg>',
)}`;

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

const meta = {
  title: 'Data Display/Avatar',
  component: Avatar,
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Avatar>
      <AvatarFallback>{initials(people[0]!.name)}</AvatarFallback>
    </Avatar>
  ),
};

export const WithImage: Story = {
  render: () => (
    <Avatar>
      <AvatarImage src={AVATAR_DATA_URI} alt="Ada Lovelace" />
    </Avatar>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      <Avatar className="h-6 w-6">
        <AvatarFallback className="text-[10px]">AL</AvatarFallback>
      </Avatar>
      <Avatar className="h-8 w-8">
        <AvatarFallback className="text-xs">AL</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback className="text-sm">AL</AvatarFallback>
      </Avatar>
      <Avatar className="h-14 w-14">
        <AvatarFallback className="text-lg">AL</AvatarFallback>
      </Avatar>
    </div>
  ),
};

export const OverlappingGroup: Story = {
  render: () => (
    <div className="flex -space-x-3">
      {people.slice(0, 4).map((person) => (
        <Avatar key={person.id} className="ring-background ring-2">
          <AvatarFallback className="text-xs">{initials(person.name)}</AvatarFallback>
        </Avatar>
      ))}
      <Avatar className="ring-background ring-2">
        <AvatarFallback className="text-text-muted text-xs">+{people.length - 4}</AvatarFallback>
      </Avatar>
    </div>
  ),
};
