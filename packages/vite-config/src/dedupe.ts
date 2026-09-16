// Context-bearing packages must resolve to ONE module instance across plugin chunks and the main bundle, or the plugin's <Link> fails context lookup.
export const REACT_SINGLETON_DEDUPE = [
  'react',
  'react-dom',
  '@tanstack/react-router',
  '@tanstack/react-query',
  '@ts-rest/react-query',
];
