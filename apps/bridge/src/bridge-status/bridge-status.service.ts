import { getDhcpStandbyHealth } from '../composition/dhcp-standby-health-holder.js';
import { getLeaderService } from '../leader-election/leader-election.service.js';
import { logDebug, logError, logInfo } from '../logger/logger.service.js';

import { getBridgeSshConfig } from './bridge-ssh.config.js';
import { getBridgeVersion } from './bridge.config.js';

const APP_CLASS_NAME = 'services-bridge-status';

// /api/status is unauthenticated: a raw Redis error (may embed hostnames/ports) must not leak.
const CLAIM_ERROR_MAX_LEN = 120;

function sanitizeClaimError(raw: string | null): string | null {
  if (raw === null) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > CLAIM_ERROR_MAX_LEN ? `${collapsed.slice(0, CLAIM_ERROR_MAX_LEN)}…` : collapsed;
}

export class BridgeStatusServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeStatusServiceError';
  }
}

export interface DhcpStandbyHealthPayload {
  is_leader: boolean;
  hydrated: boolean;
  answering: boolean;
  claim_failure_count: number;
  last_claim_error: string | null;
  hydrate_stalled_since: number | null;
}

export interface BridgeStatusPayload {
  bridge_pubkeys: string[];
  bridge_url: string;
  version: string;
  leader_election?: Record<string, unknown>;
  dhcp_standby_health?: DhcpStandbyHealthPayload;
}

// Preserves the "always a string, never null" wire contract; NOT a real key — must never appear in bridge_pubkeys.
export const PUBKEY_UNAVAILABLE = 'Not available';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BridgeStatusService {
  constructor(private readonly jobId: string = '') {}

  async getBridgeStatus(currentBridgeUrl: string, quiet = false): Promise<BridgeStatusPayload> {
    try {
      await logDebug(`Getting bridge status for URL: ${currentBridgeUrl}, quiet: ${quiet}`, {
        jobId: this.jobId,
        appClassName: APP_CLASS_NAME,
      });
      if (!quiet) {
        await logInfo('Getting bridge status information', {
          jobId: this.jobId,
          appClassName: APP_CLASS_NAME,
        });
      }

      await logDebug('Retrieving local pubkey', { jobId: this.jobId, appClassName: APP_CLASS_NAME });
      const localPubkey = await this.getLocalPubkey(quiet);
      const pubkeys = localPubkey && localPubkey !== PUBKEY_UNAVAILABLE ? [localPubkey] : [];
      await logDebug(`Local pubkey retrieved: ${pubkeys.length} keys found`, {
        jobId: this.jobId,
        appClassName: APP_CLASS_NAME,
      });

      const payload: BridgeStatusPayload = {
        bridge_pubkeys: pubkeys,
        bridge_url: currentBridgeUrl,
        version: getBridgeVersion(),
      };

      try {
        const leaderService = getLeaderService();
        if (leaderService) {
          const info = await leaderService.getLeaderInfo();
          payload.leader_election = info as unknown as Record<string, unknown>;
        }
      } catch (error) {
        if (!quiet) {
          await logDebug(`Could not get leader info: ${errorText(error)}`, {
            jobId: this.jobId,
            appClassName: APP_CLASS_NAME,
          });
        }
      }

      try {
        const standby = getDhcpStandbyHealth();
        if (standby !== null) {
          payload.dhcp_standby_health = {
            is_leader: standby.isLeader,
            hydrated: standby.hydrated,
            answering: standby.answering,
            claim_failure_count: standby.claimFailureCount,
            last_claim_error: sanitizeClaimError(standby.lastClaimError),
            hydrate_stalled_since: standby.hydrateStalledSince,
          };
        }
      } catch (error) {
        if (!quiet) {
          await logDebug(`Could not get DHCP standby health: ${errorText(error)}`, {
            jobId: this.jobId,
            appClassName: APP_CLASS_NAME,
          });
        }
      }

      if (!quiet) {
        await logInfo(`Bridge status compiled: ${pubkeys.length} pubkeys found`, {
          jobId: this.jobId,
          appClassName: APP_CLASS_NAME,
        });
      }

      return payload;
    } catch (error) {
      await logError(`Error getting bridge status: ${errorText(error)}`, {
        jobId: this.jobId,
        appClassName: APP_CLASS_NAME,
      });
      throw new BridgeStatusServiceError(`Failed to get bridge status: ${errorText(error)}`);
    }
  }

  async getLocalPubkey(quiet = false): Promise<string | null> {
    if (!quiet) {
      await logInfo('Reading local pubkey from templated SSH key files', {
        jobId: this.jobId,
        appClassName: APP_CLASS_NAME,
      });
    }

    try {
      const sshSecrets = await getBridgeSshConfig(this.jobId);
      const pubkey = sshSecrets.publicKey.trim();

      if (!quiet) {
        await logInfo(`Local pubkey retrieved - Fingerprint: ${sshSecrets.fingerprint}`, {
          jobId: this.jobId,
          appClassName: APP_CLASS_NAME,
        });
      }

      return pubkey;
    } catch (error) {
      await logError(
        `SSH keys not available; BRIDGE_SSH_PRIVKEY_PATH unset or key files missing: ${errorText(error)}`,
        { jobId: this.jobId, appClassName: APP_CLASS_NAME },
      );
      return PUBKEY_UNAVAILABLE;
    }
  }
}

export async function createBridgeStatusService(jobId = ''): Promise<BridgeStatusService> {
  return new BridgeStatusService(jobId);
}
