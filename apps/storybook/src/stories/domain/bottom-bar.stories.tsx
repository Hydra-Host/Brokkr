import { ApiMonitorContext, BottomBar, useApiMonitorProvider } from '@repo/ui/bottom-bar';
import { Button } from '@repo/ui/components/button';
import type { Meta, StoryObj } from '@storybook/react-vite';

// The monitor provider monkey-patches window.fetch while mounted (and restores
// it on unmount), so it is mounted locally inside the story component rather
// than as a global decorator. Only /api/* paths and non-GET requests are
// captured; static assets are ignored.
function BottomBarPlayground() {
  const monitor = useApiMonitorProvider();

  return (
    <ApiMonitorContext.Provider value={monitor}>
      <div className="space-y-4 p-8 pb-24">
        <div>
          <h3 className="text-sm font-medium">API monitor playground</h3>
          <p className="text-text-muted mt-1 max-w-prose text-xs">
            Fire a request, then open the panel via the API button in the bottom bar or with the Ctrl+` keyboard
            shortcut. The badge counts calls captured since the panel was last opened; there are no real API routes in
            Storybook, so expect 404s — captured all the same.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => void fetch('/api/devices?page=1').catch(() => {})}>GET /api/devices</Button>
          <Button
            variant="outline"
            onClick={() =>
              void fetch('/index.json', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ hello: 'storybook' }),
              }).catch(() => {})
            }
          >
            POST /index.json
          </Button>
          <Button variant="secondary" onClick={monitor.clear}>
            Clear captured calls
          </Button>
        </div>
      </div>
      {/* md:left-0 overrides the sidebar offset the app layout normally provides */}
      <BottomBar className="md:left-0" />
    </ApiMonitorContext.Provider>
  );
}

const meta = {
  title: 'Domain/BottomBar',
  component: BottomBar,
  parameters: {
    layout: 'fullscreen',
    docs: {
      story: { inline: false, iframeHeight: 420 },
      description: {
        component:
          'Dev-tools style bar fixed to the bottom of the viewport with an expandable API traffic panel. Toggle it with the API button, the chevron, or **Ctrl+`** (backquote — captured on keydown with no other modifiers). The panel is resizable by dragging its top edge and shows requests intercepted by `useApiMonitorProvider`, which wraps `window.fetch` and records method, path, status, duration, and parsed request/response bodies for `/api/*` and non-GET traffic (most recent 50 calls).',
      },
    },
  },
} satisfies Meta<typeof BottomBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <BottomBarPlayground />,
};
