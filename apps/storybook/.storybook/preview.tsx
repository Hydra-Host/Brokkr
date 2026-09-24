import { setDocumentTitleSuffix } from '@repo/ui/hooks/use-document-title';
import { configureUiBrand } from '@repo/ui/lib/brand';
import {
  THEME_COLORS,
  THEME_STYLES,
  ThemeProvider,
  useTheme,
  type ResolvedMode,
  type ThemeColor,
  type ThemeStyle,
} from '@repo/ui/theme-provider';
import type { Decorator, Preview } from '@storybook/react-vite';
import { useEffect } from 'react';
import './preview.css';

configureUiBrand({ name: 'Hydra' });
setDocumentTitleSuffix('Hydra UI');

// ThemeProvider owns the <html> axis attributes and the localStorage keys, so
// push toolbar globals through its setters: the toolbar then wins the restore.
function ThemeSync({ style, color, mode }: { style: ThemeStyle; color: ThemeColor; mode: ResolvedMode }) {
  const { setStyle, setColor, setMode } = useTheme();
  useEffect(() => {
    setStyle(style);
    setColor(color);
    setMode(mode);
  }, [style, color, mode, setStyle, setColor, setMode]);
  return null;
}

// Full-height themed canvas in story view; in docs view each inline story
// block hugs its content instead of stretching to viewport height.
const withTheme: Decorator = (Story, context) => (
  <ThemeProvider>
    <ThemeSync
      style={context.globals.themeStyle as ThemeStyle}
      color={context.globals.themeColor as ThemeColor}
      mode={context.globals.themeMode as ResolvedMode}
    />
    <div
      className={`bg-background text-text-primary p-8 ${context.viewMode === 'docs' ? '' : 'flex min-h-svh flex-col'}`}
    >
      <Story />
    </div>
  </ThemeProvider>
);

const preview: Preview = {
  globalTypes: {
    themeStyle: {
      description: 'Style axis (data-style on <html>)',
      toolbar: {
        title: 'Style',
        icon: 'component',
        dynamicTitle: true,
        items: THEME_STYLES.map((style) => ({ value: style.value, title: style.label })),
      },
    },
    themeColor: {
      description: 'Color axis (data-color on <html>)',
      toolbar: {
        title: 'Color',
        icon: 'paintbrush',
        dynamicTitle: true,
        items: THEME_COLORS.map((color) => ({ value: color.value, title: color.label })),
      },
    },
    themeMode: {
      description: 'Mode axis (data-mode on <html>)',
      toolbar: {
        title: 'Mode',
        icon: 'sun',
        dynamicTitle: true,
        items: [
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' },
        ],
      },
    },
  },
  initialGlobals: { themeStyle: 'modern', themeColor: 'violet', themeMode: 'dark' },
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
