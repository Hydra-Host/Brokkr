// Module declarations for text-asset imports. tsup's esbuild loader and
// vitest's Vite plugin both turn these imports into the file's text content
// as the default export. See agent/tsup.config.ts and agent/vitest.config.ts.

declare module '*.njk' {
  const content: string;
  export default content;
}

declare module '*.service' {
  const content: string;
  export default content;
}

declare module '*.sh' {
  const content: string;
  export default content;
}
