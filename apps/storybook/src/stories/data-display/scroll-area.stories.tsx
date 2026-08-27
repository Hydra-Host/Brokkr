import { ScrollArea, ScrollBar } from '@repo/ui/components/scroll-area';
import { Separator } from '@repo/ui/components/separator';
import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { people } from '../../lib/fixtures';

const meta = {
  title: 'Data Display/ScrollArea',
  component: ScrollArea,
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Vertical: Story = {
  render: () => (
    <ScrollArea className="border-border h-72 w-56 rounded-sm border">
      <div className="p-4 font-mono">
        <h4 className="text-accent mb-3 text-xs font-bold uppercase">Members</h4>
        {people.map((person, index) => (
          <React.Fragment key={person.id}>
            {index > 0 && <Separator className="my-2" />}
            <div className="text-text-muted text-sm">{person.name}</div>
          </React.Fragment>
        ))}
      </div>
    </ScrollArea>
  ),
};

export const Horizontal: Story = {
  render: () => (
    <ScrollArea className="border-border w-96 rounded-sm border whitespace-nowrap">
      <div className="flex w-max gap-4 p-4">
        {people.slice(0, 10).map((person) => (
          <figure key={person.id} className="border-border shrink-0 rounded-sm border p-3 font-mono">
            <div className="bg-bg-secondary text-accent flex h-16 w-24 items-center justify-center text-lg font-bold">
              {person.name
                .split(' ')
                .map((part) => part[0])
                .join('')}
            </div>
            <figcaption className="text-text-muted pt-2 text-xs">{person.name}</figcaption>
          </figure>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  ),
};
