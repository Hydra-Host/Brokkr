import { navigationShortcuts, useNavigationShortcuts } from '@repo/ui/hooks/use-navigation-shortcuts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLocation } from '@tanstack/react-router';
import { withRouter } from '../../lib/decorators';

function NavigationShortcutsDemo() {
  useNavigationShortcuts();
  const location = useLocation();

  return (
    <div className="border-border-dim bg-bg-secondary flex w-[480px] flex-col gap-4 border p-6 font-mono">
      <div className="flex items-center justify-between text-xs">
        <code className="text-text-muted">useNavigationShortcuts()</code>
        <span>
          <span className="text-text-dim">route: </span>
          <code className="text-accent">{location.pathname}</code>
        </span>
      </div>

      <table className="text-xs">
        <thead>
          <tr className="text-text-dim text-left">
            <th className="py-1 font-normal">shortcut</th>
            <th className="py-1 font-normal">keys</th>
            <th className="py-1 font-normal">route</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(navigationShortcuts).map(([id, shortcut]) => (
            <tr key={id} className="border-border-dim border-t">
              <td className="text-text-primary py-1 pr-4">{id}</td>
              <td className="py-1 pr-4">
                <kbd className="border-border-dim bg-bg-primary text-text-muted rounded border px-1.5 py-0.5">
                  {shortcut.display}
                </kbd>
              </td>
              <td className="text-text-dim py-1">{shortcut.isExternal ? '(external helpdesk)' : shortcut.route}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const meta = {
  title: 'Hooks/useNavigationShortcuts',
  component: NavigationShortcutsDemo,
  decorators: [withRouter],
  parameters: {
    docs: {
      description: {
        component:
          'Registers a global keydown listener for the `navigationShortcuts` map (Cmd+Shift on macOS, ' +
          'Ctrl+Shift elsewhere) and navigates via TanStack Router; entries flagged `isExternal` open the ' +
          'helpdesk URL in a new tab instead. Shortcuts are ignored while typing in inputs. Key events ' +
          'need iframe focus — click the canvas first, then try a combo and watch the route readout ' +
          'change (this story navigates an in-memory router, so unmatched routes are expected).',
      },
    },
  },
} satisfies Meta<typeof NavigationShortcutsDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
