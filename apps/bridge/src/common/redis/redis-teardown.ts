import type { Redis } from 'ioredis';

import { logDebug } from '../../logger/logger.service';
import { getErrorMessage } from '../error-utils';

export async function quitThenDisconnect(client: Redis, label: string): Promise<void> {
  // don't await quit(): with enableOfflineQueue QUIT queues behind buffered commands and can stall teardown; disconnect() abandons what's left.
  try {
    void client.quit().catch(() => {
      /* quit rejects once disconnect() races the socket closed; expected */
    });
  } catch (error) {
    void logDebug(`${label} quit failed during close: ${getErrorMessage(error)}`);
  }
  try {
    client.disconnect();
  } catch (error) {
    void logDebug(`${label} disconnect failed during close: ${getErrorMessage(error)}`);
  }
}
