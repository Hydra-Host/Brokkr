import { Badge } from '@repo/ui/components/badge';
import { useCountdown } from '@repo/ui/hooks/use-countdown';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { countdownEnd, countdownExpired } from '../../lib/fixtures';

function CountdownDemo({ end }: { end: Date }) {
  const { timeLeft } = useCountdown(end);
  const expired = timeLeft === '0s';

  return (
    <div className="border-border-dim bg-bg-secondary flex w-72 flex-col gap-3 border p-6 font-mono">
      <div className="flex items-center justify-between">
        <code className="text-text-muted text-xs">useCountdown(endTime)</code>
        <Badge variant={expired ? 'destructive' : 'success'}>{expired ? 'expired' : 'ticking'}</Badge>
      </div>
      <p className="text-accent text-2xl">{timeLeft}</p>
      <p className="text-text-dim text-xs">ends {end.toLocaleTimeString()}</p>
    </div>
  );
}

// Capture the fixture Date once per mount so the hook's effect isn't re-run
// with a fresh Date object every render.
function StableCountdown({ makeEnd }: { makeEnd: () => Date }) {
  const [end] = useState(makeEnd);
  return <CountdownDemo end={end} />;
}

const meta = {
  title: 'Hooks/useCountdown',
  component: StableCountdown,
  args: { makeEnd: countdownEnd },
  argTypes: { makeEnd: { control: false } },
  parameters: {
    docs: {
      description: {
        component:
          'Ticks once per second toward an end `Date` and returns a compact `timeLeft` string ' +
          '(`2d 4h`, `12m 30s`, `0s`). The interval stops itself once the countdown hits `0s`. ' +
          'Pass a stable `Date` reference — a new object every render restarts the effect.',
      },
    },
  },
} satisfies Meta<typeof StableCountdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Expired: Story = {
  args: { makeEnd: countdownExpired },
};
