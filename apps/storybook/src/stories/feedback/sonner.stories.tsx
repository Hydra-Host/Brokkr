import { Button } from '@repo/ui/components/button';
import { Toaster } from '@repo/ui/components/sonner';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { toast } from 'sonner';

const meta = {
  title: 'Feedback/Toaster',
  component: Toaster,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Toast notifications via sonner. Render one <Toaster /> near the app root, then fire toasts from anywhere with the `toast` function imported from sonner. The Toaster reads the brokkr theme through useTheme to pick sonner light/dark styling.',
      },
    },
  },
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => (
    <>
      <Toaster />
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" onClick={() => toast('Device event received')}>
          Default
        </Button>
        <Button variant="success" onClick={() => toast.success('Invoice INV-2041 settled')}>
          Success
        </Button>
        <Button variant="destructive" onClick={() => toast.error('Payment failed: card declined')}>
          Error
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            toast.promise(new Promise((resolve) => setTimeout(resolve, 2000)), {
              loading: 'Provisioning device…',
              success: 'Device provisioned',
              error: 'Provisioning failed',
            })
          }
        >
          Promise
        </Button>
      </div>
    </>
  ),
};
