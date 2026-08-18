// Type surface for MDX content modules (apps/docs/content/**). Compiled by
// @mdx-js/rollup (see vite.config.ts); frontmatter is exported as a named
// binding by remark-mdx-frontmatter.
declare module '*.mdx' {
  import type { ComponentType } from 'react';

  export const frontmatter: {
    title: string;
    description?: string;
    section: string;
    order?: number;
    slug?: string;
  };

  const MDXContent: ComponentType<Record<string, unknown>>;
  export default MDXContent;
}
