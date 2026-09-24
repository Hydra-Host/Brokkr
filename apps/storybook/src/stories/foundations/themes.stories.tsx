import {
  THEME_COLORS,
  THEME_STYLES,
  type ResolvedMode,
  type ThemeColorOption,
  type ThemeStyleOption,
} from '@repo/ui/theme-provider';
import { ThemeScope } from '@repo/ui/theme-scope';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';

// ThemeScope re-scopes the axis tokens per card, so every style × color × mode
// combination renders side by side regardless of the toolbar theme on <html>.
function ThemeCard({ label, sublabel }: { label: string; sublabel: string }) {
  return (
    <div className="bg-bg-primary border-border-dim flex w-52 flex-col gap-3 border p-4 font-mono">
      <div>
        <div className="text-text-primary text-sm">{label}</div>
        <div className="text-text-dim text-[10px]">{sublabel}</div>
      </div>
      <div className="bg-bg-secondary border-border-dim rounded-md border p-2">
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

// One row per color: every style × mode cell wrapped in its own ThemeScope.
function ColorSection({
  color,
  sample,
}: {
  color: ThemeColorOption;
  sample: (style: ThemeStyleOption, mode: ResolvedMode) => ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-text-muted font-mono text-xs tracking-wide uppercase">{color.label}</h3>
      <div className="flex flex-wrap gap-4">
        {THEME_STYLES.map((style) =>
          (['dark', 'light'] as const).map((mode) => (
            <ThemeScope key={`${style.value}-${mode}`} style={style.value} color={color.value} mode={mode}>
              {sample(style, mode)}
            </ThemeScope>
          )),
        )}
      </div>
    </section>
  );
}

function ThemeGallery() {
  return (
    <div className="flex flex-col gap-8">
      {THEME_COLORS.map((color) => (
        <ColorSection
          key={color.value}
          color={color}
          sample={(style, mode) => (
            <ThemeCard label={`${style.label} · ${mode}`} sublabel={`${style.value} / ${color.value} / ${mode}`} />
          )}
        />
      ))}
    </div>
  );
}

// Larger side-by-side canvas for calibrating the retro tint formulas against
// the modern neutrals — form, table, and button samples per style × mode.
function StyleSample() {
  return (
    <div className="bg-bg-primary border-border-dim flex w-80 flex-col gap-4 border p-5 font-mono">
      <div className="flex items-center justify-between">
        <span className="text-text-primary text-sm">Dashboard</span>
        <span className="bg-status-online h-2 w-2 rounded-full" />
      </div>
      <div className="bg-card border-border-dim rounded-lg border p-3">
        <div className="text-text-muted text-[11px]">Card body</div>
        <div className="text-text-dim text-[10px]">supporting copy</div>
      </div>
      <input
        readOnly
        value="input value"
        className="bg-input-background border-input-border text-input-foreground rounded-md border px-2 py-1.5 text-xs"
      />
      <table className="text-left text-[11px]">
        <thead>
          <tr className="text-table-header border-border-dim border-b">
            <th className="py-1">NAME</th>
            <th className="py-1">STATE</th>
          </tr>
        </thead>
        <tbody className="text-table-body">
          <tr className="border-border-dim border-b">
            <td className="py-1">node-01</td>
            <td className="text-status-online py-1">online</td>
          </tr>
          <tr>
            <td className="py-1">node-02</td>
            <td className="text-status-offline py-1">offline</td>
          </tr>
        </tbody>
      </table>
      <div className="flex gap-2">
        <button className="bg-accent text-accent-foreground rounded-md px-3 py-1.5 text-xs font-bold">Primary</button>
        <button className="border-accent text-accent rounded-md border px-3 py-1.5 text-xs">Outline</button>
      </div>
    </div>
  );
}

function StyleComparison() {
  return (
    <div className="flex flex-col gap-8">
      {THEME_COLORS.map((color) => (
        <ColorSection key={color.value} color={color} sample={() => <StyleSample />} />
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
          'Every style × color × mode combination rendered side by side. Each card is wrapped in a ' +
          '`ThemeScope`, which re-scopes the axis custom properties for that subtree — the same ' +
          'technique apps use to pin a theme on hosted pages. The toolbar theme still controls the ' +
          'page background around the cards.',
      },
    },
  },
} satisfies Meta<typeof ThemeGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {};

export const Comparison: StoryObj = {
  render: () => <StyleComparison />,
};
