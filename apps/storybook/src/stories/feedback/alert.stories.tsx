import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CircleCheck, CircleX, Terminal, TriangleAlert } from 'lucide-react';

const meta = {
  title: 'Feedback/Alert',
  component: Alert,
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'destructive', 'warning', 'success'],
    },
  },
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Alert className="w-96">
      <Terminal className="h-4 w-4" />
      <AlertTitle>Heads up!</AlertTitle>
      <AlertDescription>You can add components to your app using the CLI.</AlertDescription>
    </Alert>
  ),
};

export const Destructive: Story = {
  render: () => (
    <Alert variant="destructive" className="w-96">
      <CircleX className="h-4 w-4" />
      <AlertTitle>Provisioning failed</AlertTitle>
      <AlertDescription>
        The device did not respond to the PXE boot request. Check IPMI connectivity and retry.
      </AlertDescription>
    </Alert>
  ),
};

export const Warning: Story = {
  render: () => (
    <Alert variant="warning" className="w-96">
      <TriangleAlert className="h-4 w-4" />
      <AlertTitle>Certificate expiring</AlertTitle>
      <AlertDescription>The TLS certificate for this endpoint expires in 7 days.</AlertDescription>
    </Alert>
  ),
};

export const Success: Story = {
  render: () => (
    <Alert variant="success" className="w-96">
      <CircleCheck className="h-4 w-4" />
      <AlertTitle>Payment received</AlertTitle>
      <AlertDescription>Invoice INV-2041 was settled and the receipt has been emailed.</AlertDescription>
    </Alert>
  ),
};

export const DescriptionOnly: Story = {
  render: () => (
    <Alert className="w-96">
      <AlertDescription>A bare alert with only a description — no icon, no title.</AlertDescription>
    </Alert>
  ),
};
