import { loadBridgeSshPublicKey } from './initrd.config.js';

import { getLogger } from '../logger/logger.service';

export class SSHKeyService {
  readonly jobId: string;

  constructor(jobId = '') {
    this.jobId = jobId;
  }

  async getBridgeSshKeys(parseKeysFunc: (keysString: string) => string[]): Promise<string[]> {
    try {
      const publicKey = await loadBridgeSshPublicKey();
      if (!publicKey) {
        void getLogger().warning('Bridge SSH public key not configured', { jobId: this.jobId });
        return [];
      }

      const parsedKeys = parseKeysFunc(publicKey);
      void getLogger().info(`Added ${parsedKeys.length} bridge SSH key(s) for admin access`, { jobId: this.jobId });
      return parsedKeys;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void getLogger().warning(`Failed to get bridge SSH keys: ${msg}`, { jobId: this.jobId });
      return [];
    }
  }
}

export async function createSshKeyService(jobId = ''): Promise<SSHKeyService> {
  return new SSHKeyService(jobId);
}
