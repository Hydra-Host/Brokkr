import type { z } from 'zod';

import { getBootReadinessFindings } from '../composition/boot-readiness-holder.js';
import { getDhcpStandbyHealth } from '../composition/dhcp-standby-health-holder.js';
import { getDiscoverySyncRecord } from '../composition/discovery-sync-holder.js';
import { countBootFindings } from '../diagnostics/boot-readiness.js';
import { getLeaderService } from '../leader-election/leader-election.service.js';
import { logDebug, logError, logInfo } from '../logger/logger.service.js';

import { getBridgeSshConfig } from './bridge-ssh.config.js';
import type {
  bridgeStatusResponseSchema,
  dhcpPrimaryInterfaceSchema,
  dhcpStandbyHealthSchema,
  discoverySyncStatusSchema,
} from './bridge-status.schema.js';
import { getBridgeVersion } from './bridge.config.js';

const APP_CLASS_NAME = 'services-bridge-status';

// /api/status is unauthenticated: a raw Redis or transport error (may embed hostnames/ports) must not leak.
const STATUS_ERROR_MAX_LEN = 120;

function sanitizeStatusError(raw: string | null): string | null {
  if (raw === null) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > STATUS_ERROR_MAX_LEN ? `${collapsed.slice(0, STATUS_ERROR_MAX_LEN)}…` : collapsed;
}

export class BridgeStatusServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeStatusServiceError';
  }
}

export type DhcpStandbyHealthPayload = z.infer<typeof dhcpStandbyHealthSchema>;
export type DiscoverySyncStatusPayload = z.infer<typeof discoverySyncStatusSchema>;
export type DhcpPrimaryInterfacePayload = z.infer<typeof dhcpPrimaryInterfaceSchema>;

export type BridgeStatusPayload = z.infer<typeof bridgeStatusResponseSchema>;

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
        readiness_error_count: countBootFindings(getBootReadinessFindings()).error,
        leader_election: null,
        primary_interface: null,
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
            pxe_port_bound: standby.pxePortBound,
            claim_failure_count: standby.claimFailureCount,
            last_claim_error: sanitizeStatusError(standby.lastClaimError),
            hydrate_stalled_since: standby.hydrateStalledSince,
          };
          payload.primary_interface = standby.primaryInterface;
        }
      } catch (error) {
        if (!quiet) {
          await logDebug(`Could not get DHCP standby health: ${errorText(error)}`, {
            jobId: this.jobId,
            appClassName: APP_CLASS_NAME,
          });
        }
      }

      const discoverySync = getDiscoverySyncRecord();
      if (discoverySync !== null) {
        payload.discovery_sync = {
          at: discoverySync.at,
          outcome: discoverySync.outcome,
          error: sanitizeStatusError(discoverySync.error),
          base_url: discoverySync.baseUrl,
          version: discoverySync.version,
          flavors: [...discoverySync.flavors],
        };
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
