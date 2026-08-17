import nunjucks from 'nunjucks';

const startsWith = (input: unknown, prefix: unknown): boolean => String(input ?? '').startsWith(String(prefix ?? ''));

export function makeRenderEnv(): nunjucks.Environment {
  const env = new nunjucks.Environment(null, {
    throwOnUndefined: true,
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true,
  });
  env.addFilter('startswith', startsWith);
  return env;
}

export const renderEnv: nunjucks.Environment = makeRenderEnv();

export function stripTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Embedded newlines can split a shell statement or corrupt the YAML emitter; other control chars signal a hostile value.
// eslint-disable-next-line no-control-regex -- intentionally matches C0 controls + DEL
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function assertNoControlChars(label: string, value: string): void {
  if (CONTROL_CHARS.test(value)) {
    throw new Error(
      `${label} contains control characters (e.g. newline/CR/NUL); ` +
        `reject upstream before it reaches the deploy templates.`,
    );
  }
}
