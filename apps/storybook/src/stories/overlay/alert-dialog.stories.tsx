import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@repo/ui/components/alert-dialog';
import { Button } from '@repo/ui/components/button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Trash2 } from 'lucide-react';
import React from 'react';

const meta = {
  title: 'Overlay/AlertDialog',
  component: AlertDialog,
  parameters: {
    docs: {
      description: {
        component:
          'Interruptive confirmation dialog for destructive or irreversible actions. Unlike Dialog, it has no dismiss X — the user must pick an action.',
      },
    },
  },
} satisfies Meta<typeof AlertDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const DestructiveConfirmDemo = () => {
  const [open, setOpen] = React.useState(false);
  const [lastAction, setLastAction] = React.useState<string>();
  return (
    <div className="flex flex-col items-center gap-3">
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger
          render={
            <Button variant="destructive">
              <Trash2 /> Delete organization
            </Button>
          }
        />
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this organization?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. All devices, invoices, and API keys belonging to this organization will be
              permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setLastAction('cancelled')}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-status-offline hover:bg-status-offline/90"
              onClick={() => {
                setLastAction('deleted');
                setOpen(false);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <span className="text-text-muted font-mono text-xs">last action: {lastAction ?? 'none'}</span>
    </div>
  );
};

export const DestructiveConfirm: Story = {
  render: () => <DestructiveConfirmDemo />,
};
