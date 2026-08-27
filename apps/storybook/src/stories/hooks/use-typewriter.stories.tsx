import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useTypewriter } from '@repo/ui/hooks/use-typewriter';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

const SAMPLE_TEXT = 'Provisioning 8x H100 SXM in us-east-1... done.';

function TypewriterDemo({ text, speed }: { text: string; speed?: number }) {
  const { displayText, remainingText, isTyping } = useTypewriter(text, speed);

  return (
    <div className="border-border-dim bg-bg-secondary flex flex-col gap-3 border p-6 font-mono">
      <div className="flex items-center justify-between gap-6">
        <code className="text-text-muted text-xs">useTypewriter(text, speed)</code>
        <Badge variant={isTyping ? 'warning' : 'success'}>{isTyping ? 'isTyping: true' : 'isTyping: false'}</Badge>
      </div>
      <p className="text-text-primary min-h-6 text-sm">
        {displayText}
        {isTyping && <span className="text-accent animate-pulse">▋</span>}
      </p>
      <p className="text-text-dim text-xs break-all">remainingText: {remainingText || '(empty)'}</p>
    </div>
  );
}

function ReplayableTypewriter() {
  const [run, setRun] = useState(0);
  return (
    <div className="flex w-96 flex-col gap-4">
      <TypewriterDemo key={run} text={SAMPLE_TEXT} />
      <Button variant="outline" size="sm" className="self-start" onClick={() => setRun((r) => r + 1)}>
        Replay
      </Button>
    </div>
  );
}

const meta = {
  title: 'Hooks/useTypewriter',
  component: TypewriterDemo,
  args: { text: SAMPLE_TEXT },
  parameters: {
    docs: {
      description: {
        component:
          'Reveals a string one character at a time (default 40ms per character) and returns ' +
          '`displayText`, `remainingText`, and `isTyping`. Changing `text` restarts the animation.',
      },
    },
  },
} satisfies Meta<typeof TypewriterDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <ReplayableTypewriter />,
};

export const FastSpeed: Story = {
  args: { speed: 10 },
  render: (args) => (
    <div className="w-96">
      <TypewriterDemo {...args} />
    </div>
  ),
};
