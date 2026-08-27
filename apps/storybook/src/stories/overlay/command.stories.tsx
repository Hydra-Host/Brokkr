import { Button } from '@repo/ui/components/button';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@repo/ui/components/command';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Calculator, Calendar, CreditCard, Settings, Smile, User } from 'lucide-react';
import React from 'react';

const meta = {
  title: 'Overlay/Command',
  component: Command,
  parameters: {
    docs: {
      description: {
        component:
          'Fuzzy-searchable command palette built on cmdk. Use it inline as a filterable list, or inside CommandDialog for the classic ⌘K palette.',
      },
    },
  },
} satisfies Meta<typeof Command>;

export default meta;
type Story = StoryObj<typeof meta>;

const DemoItems = () => (
  <>
    <CommandEmpty>No results found.</CommandEmpty>
    <CommandGroup heading="Suggestions">
      <CommandItem>
        <Calendar className="mr-2 h-4 w-4" />
        Calendar
      </CommandItem>
      <CommandItem>
        <Smile className="mr-2 h-4 w-4" />
        Search Emoji
      </CommandItem>
      <CommandItem>
        <Calculator className="mr-2 h-4 w-4" />
        Calculator
      </CommandItem>
    </CommandGroup>
    <CommandSeparator />
    <CommandGroup heading="Settings">
      <CommandItem>
        <User className="mr-2 h-4 w-4" />
        Profile
        <CommandShortcut>⌘P</CommandShortcut>
      </CommandItem>
      <CommandItem>
        <CreditCard className="mr-2 h-4 w-4" />
        Billing
        <CommandShortcut>⌘B</CommandShortcut>
      </CommandItem>
      <CommandItem>
        <Settings className="mr-2 h-4 w-4" />
        Settings
        <CommandShortcut>⌘S</CommandShortcut>
      </CommandItem>
    </CommandGroup>
  </>
);

export const Inline: Story = {
  render: () => (
    <Command className="border-border w-96 rounded-sm border shadow-md">
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <DemoItems />
      </CommandList>
    </Command>
  ),
};

const CommandDialogDemo = () => {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open command palette
        <span className="text-text-dim ml-2 font-mono text-xs">⌘K</span>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <DemoItems />
        </CommandList>
      </CommandDialog>
    </>
  );
};

export const InDialog: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'The classic ⌘K pattern: a keydown listener on document toggles the palette on Cmd+K / Ctrl+K (also wired here — try it), and CommandDialog wraps Command in a Dialog.',
      },
    },
  },
  render: () => <CommandDialogDemo />,
};
