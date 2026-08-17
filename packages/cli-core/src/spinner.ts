import chalk from 'chalk';
import ora from 'ora';
import { getErrorMessage } from './output.js';

export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
  opts?: { onError?: (err: unknown) => never | void },
): Promise<T> {
  const spinner = ora(message).start();
  try {
    const result = await fn();
    spinner.stop();
    return result;
  } catch (err) {
    spinner.fail(chalk.red(getErrorMessage(err)));
    if (opts?.onError) {
      opts.onError(err);
    }
    process.exit(1);
  }
}
