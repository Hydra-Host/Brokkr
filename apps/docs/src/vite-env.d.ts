/// <reference types="vite/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

// Provided by docsSearchIndexPlugin in vite.config.ts.
declare module 'virtual:docs-search-index' {
  const texts: Record<string, string>;
  export default texts;
}
