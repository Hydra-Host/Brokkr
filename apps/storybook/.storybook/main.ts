import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../src/docs/**/*.mdx', '../src/stories/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  async viteFinal(config) {
    const { mergeConfig } = await import('vite');
    return mergeConfig(config, {
      plugins: [tailwindcss()],
      optimizeDeps: {
        // CJS dep of @base-ui/utils reached through the source-linked @repo/ui;
        // without prebundling, dev serves it raw and named ESM imports fail.
        include: ['use-sync-external-store/shim', 'use-sync-external-store/shim/with-selector'],
      },
    });
  },
};

export default config;
