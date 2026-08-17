import * as p from '@clack/prompts';

export function prompt<T>(result: T | symbol): T {
  if (p.isCancel(result)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  return result;
}

export async function confirmOrExit(message: string, initialValue = false): Promise<void> {
  const confirmed = prompt(await p.confirm({ message, initialValue }));
  if (!confirmed) {
    p.cancel('Cancelled');
    process.exit(0);
  }
}
