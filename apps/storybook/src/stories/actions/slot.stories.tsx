import { Slot } from '@repo/ui/components/slot';
import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

const meta = {
  title: 'Actions/Slot',
  component: Slot,
  parameters: {
    docs: {
      description: {
        component:
          'The primitive behind `asChild`: instead of rendering its own element, Slot clones its single child and merges the props it was given onto it — className and style are merged, everything else is forwarded. Components like Button use it so `<Button asChild><a/></Button>` renders a real anchor that still looks and behaves like a Button.',
      },
    },
  },
} satisfies Meta<typeof Slot>;

export default meta;
type Story = StoryObj<typeof meta>;

const MergingPropsDemo = () => {
  const [clicks, setClicks] = React.useState(0);
  return (
    <div className="flex flex-col items-center gap-3">
      <Slot
        className="border-accent text-accent cursor-pointer rounded-sm border px-4 py-2 font-mono text-sm select-none"
        onClick={() => setClicks((prev) => prev + 1)}
      >
        <span className="font-bold">I am a plain &lt;span&gt; — border, color, and onClick were merged in by Slot</span>
      </Slot>
      <span className="text-text-muted font-mono text-xs">clicks handled by the Slot's onClick: {clicks}</span>
    </div>
  );
};

export const MergingProps: Story = {
  render: () => <MergingPropsDemo />,
};
