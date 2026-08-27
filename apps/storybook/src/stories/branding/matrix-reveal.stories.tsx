import { Button } from '@repo/ui/components/button';
import { MatrixReveal } from '@repo/ui/matrix-reveal';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

const LINES = [
  '╔══════════════════════════╗',
  '║   HYDRA COMMERCE v2.0    ║',
  '║   all systems nominal    ║',
  '╚══════════════════════════╝',
];

const meta = {
  title: 'Branding/MatrixReveal',
  component: MatrixReveal,
  parameters: {
    docs: {
      description: {
        component:
          'Reveals each line left-to-right out of randomized block glyphs, matrix style. ' +
          'Remount (new `key`) to replay the animation.',
      },
    },
  },
  args: { lines: LINES },
} satisfies Meta<typeof MatrixReveal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { className: 'text-sm leading-tight' },
};

export const Delayed: Story = {
  args: { className: 'text-sm leading-tight', delay: 1000 },
};

function ReplayableMatrixReveal() {
  const [runId, setRunId] = useState(0);

  return (
    <div className="flex flex-col items-start gap-4">
      <MatrixReveal key={runId} lines={LINES} className="text-sm leading-tight" />
      <Button variant="outline" size="sm" onClick={() => setRunId((n) => n + 1)}>
        Replay
      </Button>
    </div>
  );
}

export const Replay: Story = {
  render: () => <ReplayableMatrixReveal />,
};
