export function atomsMatch<T>(a: T, b: T | null): boolean {
  if (b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
