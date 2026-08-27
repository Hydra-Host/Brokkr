import { Badge } from '@repo/ui/components/badge';
import { useIsMobile } from '@repo/ui/hooks/use-mobile';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';

function IsMobileDemo() {
  const isMobile = useIsMobile();
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div className="border-border-dim bg-bg-secondary flex w-72 flex-col gap-3 border p-6 font-mono">
      <div className="flex items-center justify-between">
        <code className="text-text-muted text-xs">useIsMobile()</code>
        <Badge variant={isMobile ? 'warning' : 'success'}>{String(isMobile)}</Badge>
      </div>
      <p className="text-text-dim text-xs">viewport: {width}px · mobile below 768px</p>
    </div>
  );
}

const meta = {
  title: 'Hooks/useIsMobile',
  component: IsMobileDemo,
  parameters: {
    docs: {
      description: {
        component:
          'Media-query hook that returns `true` below the 768px breakpoint. ' +
          'Resize the browser window (or use the viewport toolbar) to watch the readout flip live.',
      },
    },
  },
} satisfies Meta<typeof IsMobileDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
