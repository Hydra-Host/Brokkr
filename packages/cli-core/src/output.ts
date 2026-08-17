import chalk from 'chalk';

export function renderJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function ok(msg: string): void {
  console.log(`  ${chalk.green('✓')} ${msg}`);
}

export function fail(msg: string): never {
  console.error(`  ${chalk.red('✗')} ${msg}`);
  process.exit(1);
}

export function warn(msg: string): void {
  console.log(`  ${chalk.yellow(msg)}`);
}

export function info(label: string, value: string): void {
  console.log(`  ${label}: ${value}`);
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
