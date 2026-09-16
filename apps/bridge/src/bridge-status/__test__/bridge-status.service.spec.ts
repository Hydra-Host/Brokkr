import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetBootReadinessFindingsForTests,
  setBootReadinessFindings,
} from '../../composition/boot-readiness-holder.js';
import {
  resetDhcpStandbyHealthGetterForTests,
  setDhcpStandbyHealthGetter,
} from '../../composition/dhcp-standby-health-holder.js';
import { resetDiscoverySyncRecordForTests, setDiscoverySyncRecord } from '../../composition/discovery-sync-holder.js';
import { setLeaderService } from '../../leader-election/leader-election.service.js';
import { resetBridgeSshConfigForTests } from '../bridge-ssh.config.js';
import { bridgeStatusResponseSchema } from '../bridge-status.schema.js';
import { BridgeStatusService, BridgeStatusServiceError, createBridgeStatusService } from '../bridge-status.service.js';

const VALID_PUBKEY_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_PUBKEY = `ssh-ed25519 ${VALID_PUBKEY_BLOB} fake@bridge`;

async function writeKeyPair(dir: string, pubkey = VALID_PUBKEY): Promise<string> {
  const priv = join(dir, 'id_ed25519');
  await writeFile(priv, 'PRIVATE-KEY-BYTES\n', 'utf-8');
  await writeFile(`${priv}.pub`, `${pubkey}\n`, 'utf-8');
  return priv;
}

describe('BridgeStatusService', () => {
  let prevPriv: string | undefined;
  let prevSsh: string | undefined;
  let tmp: string;

  beforeEach(async () => {
    prevPriv = process.env.BRIDGE_SSH_PRIVKEY_PATH;
    prevSsh = process.env.SSH_KEY_PATH;
    setLeaderService(null);
    resetBridgeSshConfigForTests();
    resetBootReadinessFindingsForTests();
    tmp = await mkdtemp(join(tmpdir(), 'bridge-status-'));
  });

  afterEach(async () => {
    if (prevPriv === undefined) delete process.env.BRIDGE_SSH_PRIVKEY_PATH;
    else process.env.BRIDGE_SSH_PRIVKEY_PATH = prevPriv;
    if (prevSsh === undefined) delete process.env.SSH_KEY_PATH;
    else process.env.SSH_KEY_PATH = prevSsh;
    setLeaderService(null);
    resetBridgeSshConfigForTests();
    resetDhcpStandbyHealthGetterForTests();
    resetBootReadinessFindingsForTests();
    resetDiscoverySyncRecordForTests();
    await rm(tmp, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('test_initialization', () => {
      const service = new BridgeStatusService('test-job-123');
      expect(service).toBeInstanceOf(BridgeStatusService);
    });
  });

  describe('getLocalPubkey', () => {
    it('test_get_local_pubkey_returns_sentinel_on_missing_env', async () => {
      delete process.env.BRIDGE_SSH_PRIVKEY_PATH;
      delete process.env.SSH_KEY_PATH;
      const service = new BridgeStatusService('test-job-123');
      const result = await service.getLocalPubkey();
      expect(result).toBe('Not available');
    });

    it('test_get_local_pubkey_unexpected_error', async () => {
      process.env.BRIDGE_SSH_PRIVKEY_PATH = '/nonexistent/path/to/key';
      const service = new BridgeStatusService('test-job-123');
      const result = await service.getLocalPubkey();
      expect(result).toBe('Not available');
    });

    it('test_get_local_pubkey_quiet_mode', async () => {
      const priv = await writeKeyPair(tmp);
      process.env.BRIDGE_SSH_PRIVKEY_PATH = priv;
      const service = new BridgeStatusService('test-job-123');
      const result = await service.getLocalPubkey(true);
      expect(result).toBe(VALID_PUBKEY);
    });

    it('test_get_local_pubkey_strips_whitespace', async () => {
      const priv = join(tmp, 'id_ed25519');
      await writeFile(priv, 'PRIVATE-KEY-BYTES\n', 'utf-8');
      await writeFile(`${priv}.pub`, `\n  ${VALID_PUBKEY}  \n`, 'utf-8');
      process.env.BRIDGE_SSH_PRIVKEY_PATH = priv;
      const service = new BridgeStatusService('test-job-123');
      const result = await service.getLocalPubkey();
      expect(result).toBe(VALID_PUBKEY);
    });

    it('SSH_KEY_PATH overrides BRIDGE_SSH_PRIVKEY_PATH', async () => {
      const overridePriv = await writeKeyPair(tmp);
      process.env.SSH_KEY_PATH = overridePriv;
      process.env.BRIDGE_SSH_PRIVKEY_PATH = '/should-not-be-used';
      const service = new BridgeStatusService('t');
      const result = await service.getLocalPubkey(true);
      expect(result).toBe(VALID_PUBKEY);
    });
  });

  describe('getBridgeStatus', () => {
    it('test_get_bridge_status_local_only', async () => {
      const localPubkey = 'ssh-rsa AAAAB3NzaC1yc2E local@bridge';
      const currentUrl = 'https://current.bridge.example.com';
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue(localPubkey);

      const result = await service.getBridgeStatus(currentUrl);

      expect(result.bridge_url).toBe(currentUrl);
      expect(result.bridge_pubkeys).toHaveLength(1);
      expect(result.bridge_pubkeys[0]).toBe(localPubkey);
    });

    it('test_get_bridge_status_no_pubkeys', async () => {
      const currentUrl = 'https://current.bridge.example.com';
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue(null);

      const result = await service.getBridgeStatus(currentUrl);

      expect(result.bridge_url).toBe(currentUrl);
      expect(result.bridge_pubkeys).toEqual([]);
    });

    it('excludes the "Not available" sentinel from bridge_pubkeys (real failure-path value)', async () => {
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('Not available');

      const result = await service.getBridgeStatus('https://current.bridge.example.com');

      expect(result.bridge_pubkeys).toEqual([]);
    });

    it('test_get_bridge_status_quiet_mode', async () => {
      const localPubkey = 'ssh-rsa AAAAB3NzaC1yc2E local@bridge';
      const currentUrl = 'https://current.bridge.example.com';
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue(localPubkey);

      const result = await service.getBridgeStatus(currentUrl, true);

      expect(result.bridge_url).toBe(currentUrl);
      expect(result.bridge_pubkeys).toHaveLength(1);
    });

    it('test_get_bridge_status_exception', async () => {
      const currentUrl = 'https://current.bridge.example.com';
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockRejectedValue(new Error('Unexpected error'));

      await expect(service.getBridgeStatus(currentUrl)).rejects.toThrow(BridgeStatusServiceError);
      await expect(service.getBridgeStatus(currentUrl)).rejects.toThrow(/Failed to get bridge status/);
    });

    it('includes version field', async () => {
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');
      const result = await service.getBridgeStatus('u');
      expect(typeof result.version).toBe('string');
      expect(result.version.length).toBeGreaterThan(0);
    });

    it('leader_election is attached when leader service is registered', async () => {
      const leaderInfo = { is_leader: 'True', instance_id: 'inst-1' };
      setLeaderService({
        getLeaderInfo: vi.fn().mockResolvedValue(leaderInfo),
      } as any);
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');
      expect(result.leader_election).toEqual(leaderInfo);
    });

    it('leader_election failure does not break status assembly', async () => {
      setLeaderService({
        getLeaderInfo: vi.fn().mockRejectedValue(new Error('leader probe failed')),
      } as any);
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');
      expect(result.leader_election).toBeNull();
      expect(result.bridge_pubkeys).toEqual(['k']);
    });

    it('leader_election failure does not drop dhcp_standby_health (independent failure isolation)', async () => {
      setLeaderService({
        getLeaderInfo: vi.fn().mockRejectedValue(new Error('leader probe failed')),
      } as any);
      setDhcpStandbyHealthGetter(() => ({
        isLeader: true,
        hydrated: true,
        answering: true,
        pxePortBound: true,
        claimFailureCount: 0,
        lastClaimError: null,
        hydrateStalledSince: null,
        primaryInterface: null,
      }));
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');
      expect(result.leader_election).toBeNull();
      expect(result.dhcp_standby_health).toEqual({
        is_leader: true,
        hydrated: true,
        answering: true,
        pxe_port_bound: true,
        claim_failure_count: 0,
        last_claim_error: null,
        hydrate_stalled_since: null,
      });
    });

    it('dhcp_standby_health is attached (snake_cased) when the DHCP getter is bound', async () => {
      setDhcpStandbyHealthGetter(() => ({
        isLeader: true,
        hydrated: true,
        answering: true,
        pxePortBound: true,
        claimFailureCount: 0,
        lastClaimError: null,
        hydrateStalledSince: null,
        primaryInterface: null,
      }));
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');
      expect(result.dhcp_standby_health).toEqual({
        is_leader: true,
        hydrated: true,
        answering: true,
        pxe_port_bound: true,
        claim_failure_count: 0,
        last_claim_error: null,
        hydrate_stalled_since: null,
      });
    });

    it('is omitted when DHCP is off (getter unbound / returns null)', async () => {
      setDhcpStandbyHealthGetter(() => null);
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');
      expect(result.dhcp_standby_health).toBeUndefined();
    });

    it('readiness_error_count is zero while the startup holder is empty', async () => {
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');
      expect(result.readiness_error_count).toBe(0);
    });

    it('readiness_error_count counts only error-severity startup findings', async () => {
      setBootReadinessFindings('ipxe_builds', [
        { code: 'PXE-01', severity: 'error', message: 'amd64 has no efi binary' },
        { code: 'PXE-01', severity: 'error', message: 'arm64 has no efi binary' },
      ]);
      setBootReadinessFindings('chain_reachability', [{ code: 'PXE-07', severity: 'warn', message: 'dns off' }]);
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');
      expect(result.readiness_error_count).toBe(2);
    });

    it('sanitizes last_claim_error: collapses whitespace and length-caps so raw Redis detail cannot leak', async () => {
      const raw = `redis down\n  at ${'internal-host.example.com:6379 '.repeat(20)}`;
      setDhcpStandbyHealthGetter(() => ({
        isLeader: false,
        hydrated: false,
        answering: false,
        pxePortBound: false,
        claimFailureCount: 3,
        lastClaimError: raw,
        hydrateStalledSince: null,
        primaryInterface: null,
      }));
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');
      const sanitized = result.dhcp_standby_health?.last_claim_error ?? '';
      expect(sanitized).not.toContain('\n');
      expect(sanitized.length).toBeLessThanOrEqual(121);
      expect(sanitized.length).toBeLessThan(raw.length);
      expect(result.dhcp_standby_health?.claim_failure_count).toBe(3);
    });
  });

  describe('primary_interface', () => {
    it('reports the primary interface the dhcp server-id came from', async () => {
      setDhcpStandbyHealthGetter(() => ({
        isLeader: true,
        hydrated: true,
        answering: true,
        pxePortBound: true,
        claimFailureCount: 0,
        lastClaimError: null,
        hydrateStalledSince: null,
        primaryInterface: { name: 'eth0', ip: '10.0.0.1' },
      }));
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');

      expect(result.primary_interface).toEqual({ name: 'eth0', ip: '10.0.0.1' });
      expect(bridgeStatusResponseSchema.parse(result).primary_interface).toEqual(result.primary_interface);
    });

    it('primary_interface is null when DHCP is off', async () => {
      setDhcpStandbyHealthGetter(() => null);
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');

      expect(result.primary_interface).toBeNull();
      expect(bridgeStatusResponseSchema.parse(result).primary_interface).toBeNull();
    });

    it('primary_interface is null when DHCP is active but no primary interface has resolved', async () => {
      setDhcpStandbyHealthGetter(() => ({
        isLeader: true,
        hydrated: true,
        answering: true,
        pxePortBound: true,
        claimFailureCount: 0,
        lastClaimError: null,
        hydrateStalledSince: null,
        primaryInterface: null,
      }));
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');

      expect(result.dhcp_standby_health).toBeDefined();
      expect(result.primary_interface).toBeNull();
      expect(bridgeStatusResponseSchema.parse(result).primary_interface).toBeNull();
    });
  });

  describe('discovery_sync', () => {
    it('reports the last sync outcome on the status route', async () => {
      setDiscoverySyncRecord({
        at: 1_757_600_000_000,
        outcome: 'ok',
        error: null,
        baseUrl: 'https://assets.test/brokkr-live',
        version: '9.9.9',
        flavors: ['light', 'full'],
      });
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');

      expect(result.discovery_sync).toEqual({
        at: 1_757_600_000_000,
        outcome: 'ok',
        error: null,
        base_url: 'https://assets.test/brokkr-live',
        version: '9.9.9',
        flavors: ['light', 'full'],
      });
      expect(bridgeStatusResponseSchema.parse(result).discovery_sync).toEqual(result.discovery_sync);
    });

    it('omits discovery_sync until the first sync pass finishes', async () => {
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');

      expect(result.discovery_sync).toBeUndefined();
      expect(bridgeStatusResponseSchema.parse(result).discovery_sync).toBeUndefined();
    });

    it('sanitizes the sync error so raw transport detail cannot leak', async () => {
      const raw = `HTTP 503 fetching\n  ${'https://internal-host.example.com/brokkr-live/manifest.json '.repeat(10)}`;
      setDiscoverySyncRecord({
        at: 1,
        outcome: 'failed',
        error: raw,
        baseUrl: 'https://assets.test/brokkr-live',
        version: '9.9.9',
        flavors: ['full'],
      });
      const service = new BridgeStatusService('test-job');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

      const result = await service.getBridgeStatus('u');

      const sanitized = result.discovery_sync?.error ?? '';
      expect(sanitized).not.toContain('\n');
      expect(sanitized.length).toBeLessThanOrEqual(121);
      expect(sanitized.length).toBeLessThan(raw.length);
      expect(result.discovery_sync?.outcome).toBe('failed');
    });
  });

  it('emits every payload field through the response schema', async () => {
    setDhcpStandbyHealthGetter(() => ({
      isLeader: true,
      hydrated: false,
      answering: false,
      pxePortBound: true,
      claimFailureCount: 2,
      lastClaimError: 'redis unreachable',
      hydrateStalledSince: 1_757_600_000_500,
      primaryInterface: { name: 'eth0', ip: '10.0.0.1' },
    }));
    setDiscoverySyncRecord({
      at: 1_757_600_000_000,
      outcome: 'failed',
      error: 'HTTP 503 fetching manifest',
      baseUrl: 'https://assets.test/brokkr-live',
      version: '9.9.9',
      flavors: ['light', 'full'],
    });
    setBootReadinessFindings('ipxe_builds', [
      { code: 'PXE-01', severity: 'error', message: 'amd64 has no efi binary' },
    ]);
    const service = new BridgeStatusService('test-job');
    vi.spyOn(service, 'getLocalPubkey').mockResolvedValue('k');

    const payload = await service.getBridgeStatus('u');

    expect(bridgeStatusResponseSchema.parse(payload)).toEqual(payload);
  });

  describe('createBridgeStatusService factory', () => {
    it('test_create_bridge_status_service_factory', async () => {
      const service = await createBridgeStatusService('factory-test-job');
      expect(service).toBeInstanceOf(BridgeStatusService);
    });

    it('test_create_bridge_status_service_factory_default_job_id', async () => {
      const service = await createBridgeStatusService();
      expect(service).toBeInstanceOf(BridgeStatusService);
    });
  });

  describe('edge cases', () => {
    it('test_get_bridge_status_empty_url', async () => {
      const localPubkey = 'ssh-rsa AAAAB3NzaC1yc2E local@bridge';
      const service = new BridgeStatusService('edge-test');
      vi.spyOn(service, 'getLocalPubkey').mockResolvedValue(localPubkey);

      const result = await service.getBridgeStatus('');

      expect(result.bridge_url).toBe('');
      expect(result.bridge_pubkeys).toHaveLength(1);
    });
  });
});
