export const builtinModules: string[] = [];
export function createRequire(): () => never {
  return () => {
    throw new Error('require is not available in the browser');
  };
}
