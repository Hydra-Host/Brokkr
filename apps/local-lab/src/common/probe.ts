import { getErrorMessage } from './errors';

/** Auxiliary read that degrades to null on its own, so one failed probe never discards the reads
 *  beside it. Null is "could not be determined" — callers must not report it as a measured zero. */
export async function probe<T>(read: () => Promise<T>, onError: (message: string) => void): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    onError(getErrorMessage(error));
    return null;
  }
}
