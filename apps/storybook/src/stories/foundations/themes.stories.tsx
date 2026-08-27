import { THEME_CATEGORIES, type ThemeOption } from '@repo/ui/theme-provider';
import type { Meta, StoryObj } from '@storybook/react-vite';

// brokkr.css scopes every theme with a bare [data-theme='…'] selector, so a
// nested data-theme attribute re-scopes the custom properties for its subtree.
// That lets this gallery render all nine themes side by side regardless of the
// theme the toolbar has applied to <html>.
function ThemeCard({ option }: { option: ThemeOption }) {
  return (
    <div
      data-theme={option.value}
      className="bg-bg-primary border-border-dim flex w-52 flex-col gap-3 border p-4 font-mono"
    >
      <div>
        <div className="text-text-primary text-sm">{option.label}</div>
        <div className="text-text-dim text-[10px]">{option.value}</div>
      </div>
      <div className="bg-bg-secondary border-border-dim border p-2">
        <div className="text-text-primary text-xs">primary text</div>
        <div className="text-text-muted text-[11px]">muted text</div>
        <div className="text-accent text-[11px]">accent text</div>
      </div>
      <div className="flex gap-1.5">
        <span className="bg-accent h-5 w-5" title="accent" />
        <span className="bg-accent-dim h-5 w-5" title="accent-dim" />
        <span className="bg-status-online h-5 w-5" title="status-online" />
        <span className="bg-status-warning h-5 w-5" title="status-warning" />
        <span className="bg-status-offline h-5 w-5" title="status-offline" />
        <span className="bg-status-info h-5 w-5" title="status-info" />
      </div>
    </div>
  );
}

function ThemeGallery() {
  return (
    <div className="flex flex-col gap-8">
      {THEME_CATEGORIES.map((category) => (
        <section key={category.name} className="flex flex-col gap-3">
          <h3 className="text-text-muted font-mono text-xs tracking-wide uppercase">{category.name}</h3>
          <div className="flex flex-wrap gap-4">
            {category.themes.map((option) => (
              <ThemeCard key={option.value} option={option} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const meta = {
  title: 'Foundations/Themes',
  component: ThemeGallery,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'All nine brokkr themes rendered side by side. Each card wraps its content in a nested ' +
          '`data-theme` attribute, which re-scopes the CSS custom properties for that subtree — the ' +
          'same technique apps use to force a theme on hosted pages. The toolbar theme still controls ' +
          'the page background around the cards.',
      },
    },
  },
} satisfies Meta<typeof ThemeGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {};
