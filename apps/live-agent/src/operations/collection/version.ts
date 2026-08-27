import { getErrorMessage } from '@repo/utils';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { makeLogger } from '../../logger';

const logger = makeLogger('collection');

export function registerVersionCollector(agentVersion: string): void {
  registerOperation('collection.version', async () => {
    const versions: { collector_version: string; iso_version?: string } = {
      collector_version: agentVersion,
    };

    try {
      const { stdout, exit_code } = await run('cat', ['/opt/brokkr/iso-version'], {
        timeout_ms: 5_000,
      });
      const trimmed = stdout.trim();
      if (exit_code === 0 && trimmed !== '') {
        versions.iso_version = trimmed;
      }
    } catch (error) {
      logger.debug('iso-version read failed', { path: '/opt/brokkr/iso-version', error: getErrorMessage(error) });
    }

    return { version: versions };
  });
}
