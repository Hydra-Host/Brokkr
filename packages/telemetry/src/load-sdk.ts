/** Isolated so a disabled boot never loads the SDK; under vitest this seam must be mocked — require of a .ts source doesn't resolve there. */
export function loadSdkModule(): typeof import('./sdk') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./sdk');
}
