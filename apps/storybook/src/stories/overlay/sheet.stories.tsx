import { Button } from '@repo/ui/components/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@repo/ui/components/sheet';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Overlay/Sheet',
  component: Sheet,
  parameters: {
    docs: {
      description: {
        component:
          'Panel that slides in from an edge of the screen. Pick the edge with the `side` prop on SheetContent (default: right). SheetTrigger is the raw base-ui trigger — compose a Button via its `render` prop.',
      },
    },
  },
} satisfies Meta<typeof Sheet>;

export default meta;
type Story = StoryObj<typeof meta>;

const DemoSheet = ({ side }: { side: 'top' | 'right' | 'bottom' | 'left' }) => (
  <Sheet>
    <SheetTrigger render={<Button variant="outline">Open {side}</Button>} />
    <SheetContent side={side}>
      <SheetHeader>
        <SheetTitle>Device details</SheetTitle>
        <SheetDescription>
          Slides in from the {side} edge. Click the X, press Escape, or click the backdrop to dismiss.
        </SheetDescription>
      </SheetHeader>
    </SheetContent>
  </Sheet>
);

export const Right: Story = {
  render: () => <DemoSheet side="right" />,
};

export const Left: Story = {
  render: () => <DemoSheet side="left" />,
};

export const Top: Story = {
  render: () => <DemoSheet side="top" />,
};

export const Bottom: Story = {
  render: () => <DemoSheet side="bottom" />,
};
