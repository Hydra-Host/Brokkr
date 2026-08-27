import { setDocumentTitleSuffix } from '@repo/ui/hooks/use-document-title';
import { configureUiBrand } from '@repo/ui/lib/brand';
import { THEME_CATEGORIES, ThemeProvider, useTheme, type Theme } from '@repo/ui/theme-provider';
import type { Decorator, Preview } from '@storybook/react-vite';
import { useEffect } from 'react';
import './preview.css';

configureUiBrand({ name: 'Hydra' });
setDocumentTitleSuffix('Hydra UI');

// ThemeProvider owns [data-theme] on <html> and persists to localStorage
// (brokkr-* keys). Rather than fighting it by writing dataset.theme directly,
// this bridge pushes the toolbar global through setTheme() so the toolbar
// always wins over the provider's localStorage restore.
function ThemeSync({ theme }: { theme: Theme }) {
  const { setTheme } = useTheme();
  useEffect(() => {
    setTheme(theme);
  }, [theme, setTheme]);
  return null;
}

// Full-height themed canvas in story view; in docs view each inline story
// block hugs its content instead of stretching to viewport height.
const withTheme: Decorator = (Story, context) => (
  <ThemeProvider>
    <ThemeSync theme={context.globals.theme as Theme} />
    <div
      className={`bg-background text-text-primary p-8 ${context.viewMode === 'docs' ? '' : 'flex min-h-svh flex-col'}`}
    >
      <Story />
    </div>
  </ThemeProvider>
);

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Brokkr theme (data-theme on <html>)',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        dynamicTitle: true,
        items: THEME_CATEGORIES.flatMap((category) =>
          category.themes.map((theme) => ({
            value: theme.value,
            title: `${category.name} · ${theme.label} (${theme.value})`,
          })),
        ),
      },
    },
  },
  initialGlobals: { theme: 'commerce-dark' },
  decorators: [withTheme],
  parameters: {
    layout: 'centered',
    backgrounds: { disable: true },
    docs: { toc: true },
    options: {
      storySort: {
        order: [
          'Overview',
          'Guides',
          ['Getting Started', 'Theming', 'Contributing'],
          'Foundations',
          'Actions',
          'Forms',
          ['Primitives', 'React Hook Form'],
          'Data Display',
          'Charts',
          'Feedback',
          'Overlay',
          'Navigation',
          'Branding',
          'Domain',
          'Hooks',
          'Utilities',
        ],
      },
    },
  },
  tags: ['autodocs'],
};

export default preview;
