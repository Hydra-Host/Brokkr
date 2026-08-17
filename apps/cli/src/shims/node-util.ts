// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b[A-Za-z]/g;

export function stripVTControlCharacters(str: string): string {
  return str.replace(ANSI_RE, '');
}

export function inspect(value: unknown): string {
  return String(value);
}

export function format(fmt: unknown, ...args: unknown[]): string {
  return String(fmt) + (args.length ? ' ' + args.map(String).join(' ') : '');
}

export function promisify(fn: (...args: unknown[]) => void): (...args: unknown[]) => Promise<unknown> {
  return (...args) =>
    new Promise((resolve, reject) =>
      fn(...args, (err: unknown, result: unknown) => (err ? reject(err) : resolve(result))),
    );
}

export default { stripVTControlCharacters, inspect, format, promisify };
