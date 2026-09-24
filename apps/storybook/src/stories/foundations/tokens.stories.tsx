import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';

const COLOR_TOKENS = [
  '--color-bg-primary',
  '--color-bg-secondary',
  '--color-text-primary',
  '--color-text-muted',
  '--color-text-dim',
  '--color-text-label',
  '--color-accent',
  '--color-accent-dim',
  '--color-border',
  '--color-border-dim',
  '--color-status-online',
  '--color-status-offline',
  '--color-status-warning',
  '--color-status-price',
  '--color-status-info',
  '--color-status-purple',
];

const RADIUS_TOKENS = ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl'];

// Re-render when the toolbar (ThemeProvider) swaps the axis attributes on <html>.
function readAxes() {
  const { style, color, mode } = document.documentElement.dataset;
  return [style, color, mode].filter(Boolean).join(' / ');
}

function useActiveTheme() {
  const [theme, setTheme] = useState(readAxes);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readAxes()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-style', 'data-color', 'data-mode'],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function TokensDemo() {
  const theme = useActiveTheme();
  const styles = getComputedStyle(document.documentElement);
  const resolve = (token: string) => styles.getPropertyValue(token).trim();

  return (
    <div className="flex w-[640px] flex-col gap-8 font-mono">
      <section className="flex flex-col gap-3">
        <h3 className="text-text-muted text-xs tracking-wide uppercase">Colors · active theme: {theme || '(none)'}</h3>
        <div className="grid grid-cols-2 gap-2">
          {COLOR_TOKENS.map((token) => (
            <div key={token} className="border-border-dim flex items-center gap-3 border p-2">
              <span
                className="border-border-dim h-8 w-8 shrink-0 border"
                style={{ backgroundColor: `var(${token})` }}
              />
              <span className="flex flex-col text-xs">
                <code className="text-text-primary">{token}</code>
                <code className="text-text-dim text-[10px]">{resolve(token) || '(unset)'}</code>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-text-muted text-xs tracking-wide uppercase">
          Typography · --font-mono: {resolve('--font-mono') || '(unset)'}
        </h3>
        <div className="border-border-dim flex flex-col gap-2 border p-4">
          <span className="text-text-primary text-2xl">Heading 2xl</span>
          <span className="text-text-primary text-lg">Heading lg</span>
          <span className="text-text-primary text-sm">
            Body sm — the quick brown fox jumps over the lazy dog 0123456789
          </span>
          <span className="text-text-muted text-xs">Muted xs — the quick brown fox jumps over the lazy dog</span>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-text-muted text-xs tracking-wide uppercase">
          Radius · 0 in the retro style, rounded in the modern style
        </h3>
        <div className="flex gap-4">
          {RADIUS_TOKENS.map((token) => (
            <div key={token} className="flex flex-col items-center gap-1.5">
              <span
                className="bg-bg-secondary border-border h-14 w-14 border"
                style={{ borderRadius: `var(${token})` }}
              />
              <code className="text-text-dim text-[10px]">
                {token.replace('--radius-', '')}: {resolve(token) || '0'}
              </code>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const meta = {
  title: 'Foundations/Colors & Tokens',
  component: TokensDemo,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The main `--color-*`, `--font-mono`, and `--radius-*` custom properties resolved from ' +
          '`getComputedStyle(document.documentElement)` for the theme currently applied by the toolbar. ' +
          'A MutationObserver on the `data-style`/`data-color`/`data-mode` attributes re-renders the ' +
          'grid when the theme changes.',
      },
    },
  },
} satisfies Meta<typeof TokensDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
