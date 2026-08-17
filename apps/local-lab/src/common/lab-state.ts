import { join } from 'node:path';

// LOCAL_STATE means `…/local/state` here but `…/local` in storage.service.ts; the two agree whenever
// the var is set and only the unset fallback differs, so don't align one to the other.
export function labStateDir(): string {
  return process.env.LOCAL_STATE || join(process.env.HOME || '/tmp', '.local/share/local/state');
}

export function labRunLogDir(): string {
  return join(labStateDir(), 'lab', 'runs');
}
