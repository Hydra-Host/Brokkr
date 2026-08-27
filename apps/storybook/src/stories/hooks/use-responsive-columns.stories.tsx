import { Badge } from '@repo/ui/components/badge';
import { Label } from '@repo/ui/components/label';
import { Switch } from '@repo/ui/components/switch';
import { useResponsiveColumns } from '@repo/ui/hooks/use-responsive-columns';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';

// Column id -> smallest breakpoint at which the column stays visible.
const columnConfig: Record<string, 'mobile' | 'tablet' | 'desktop'> = {
  name: 'mobile',
  status: 'mobile',
  email: 'tablet',
  role: 'tablet',
  createdAt: 'desktop',
};

function ResponsiveColumnsDemo() {
  const [expanded, setExpanded] = useState(false);
  const visibility = useResponsiveColumns(columnConfig, expanded);
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const breakpoint = width < 768 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop';

  return (
    <div className="border-border-dim bg-bg-secondary flex w-96 flex-col gap-4 border p-6 font-mono">
      <div className="flex items-center justify-between">
        <code className="text-text-muted text-xs">useResponsiveColumns(config, expanded)</code>
        <Badge variant="info">
          {breakpoint} · {width}px
        </Badge>
      </div>

      <div className="flex flex-col gap-1.5">
        {Object.entries(columnConfig).map(([columnId, minBreakpoint]) => (
          <div key={columnId} className="flex items-center justify-between text-xs">
            <span className="text-text-primary">{columnId}</span>
            <span className="flex items-center gap-2">
              <span className="text-text-dim">min: {minBreakpoint}</span>
              <Badge size="sm" variant={visibility[columnId] ? 'success' : 'secondary'}>
                {String(visibility[columnId])}
              </Badge>
            </span>
          </div>
        ))}
      </div>

      <div className="border-border-dim flex items-center gap-3 border-t pt-4">
        <Switch id="expanded" checked={expanded} onCheckedChange={setExpanded} />
        <Label htmlFor="expanded" className="text-xs">
          expanded (force all columns visible)
        </Label>
      </div>
    </div>
  );
}

const meta = {
  title: 'Hooks/useResponsiveColumns',
  component: ResponsiveColumnsDemo,
  parameters: {
    docs: {
      description: {
        component:
          'Maps a `{ columnId: minBreakpoint }` config to a TanStack Table `VisibilityState` for the ' +
          'current viewport (mobile < 768px, tablet < 1024px, desktop otherwise). Passing `expanded: true` ' +
          'overrides the breakpoints and shows every column. Resize the window to watch the flags flip.',
      },
    },
  },
} satisfies Meta<typeof ResponsiveColumnsDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
