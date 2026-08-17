export interface StackSearch {
  init: string | undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// the name only has to be a string here; the API validates it against the derived init roster and 404s
// anything it does not carry.
export function validateStackSearch(search: Record<string, unknown>): StackSearch {
  return { init: text(search.init) };
}
