import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { syncLogWarning } from '../logger/sync-log.js';
import { resolveBridgeSshPrivkeyPath } from '../ssh/ssh.config.js';

export interface BridgeSshSecrets {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

export function isBridgeSshComplete(secrets: BridgeSshSecrets): boolean {
  return Boolean(secrets.privateKey && secrets.publicKey && secrets.fingerprint);
}

export function sshFingerprint(pubkey: string): string {
  const parts = pubkey.trim().split(/\s+/);
  if (parts.length < 2) return '';
  const blobB64 = parts[1];
  if (blobB64 === undefined || blobB64 === '') return '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blobB64) || blobB64.length % 4 !== 0) return '';
  const blob = Buffer.from(blobB64, 'base64');
  if (blob.toString('base64') !== blobB64) return '';
  const digest = createHash('sha256').update(blob).digest();
  return 'SHA256:' + digest.toString('base64').replace(/=+$/, '');
}

export async function envLoadBridgeSsh(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ privkey: string; pubkey: string; fingerprint: string } | null> {
  const privkeyPath = resolveBridgeSshPrivkeyPath(env);
  if (!privkeyPath) return null;

  const pubkeyPath = `${privkeyPath}.pub`;
  let privkey: string;
  let pubkey: string;
  try {
    privkey = (await readFile(privkeyPath, 'utf-8')).trim();
    pubkey = (await readFile(pubkeyPath, 'utf-8')).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    syncLogWarning(`BRIDGE_SSH_PRIVKEY_PATH set but key files unreadable (${msg})`);
    return null;
  }

  if (!privkey || !pubkey) {
    syncLogWarning(`BRIDGE_SSH key files at ${privkeyPath} / ${pubkeyPath} are empty`);
    return null;
  }

  const fingerprint = sshFingerprint(pubkey);
  if (!fingerprint) {
    syncLogWarning(`BRIDGE_SSH pubkey at ${pubkeyPath} is malformed; cannot compute fingerprint`);
    return null;
  }

  return { privkey, pubkey, fingerprint };
}

type EnvPayload = { privkey: string; pubkey: string; fingerprint: string };
type EnvLoader = () => Promise<EnvPayload | null>;

export async function resolveEnvSecret(opts: {
  slug: string;
  envLoader: EnvLoader;
  required: boolean;
}): Promise<EnvPayload | null> {
  const payload = await opts.envLoader();
  if (payload !== null) return payload;
  if (opts.required) {
    throw new Error(`Required env vars for slug '${opts.slug}' are missing`);
  }
  return null;
}

let cache: BridgeSshSecrets | null = null;
let cacheInFlight: Promise<BridgeSshSecrets> | null = null;

export async function getBridgeSshConfig(_jobId = ''): Promise<BridgeSshSecrets> {
  if (cache !== null) return cache;
  if (cacheInFlight !== null) return cacheInFlight;

  cacheInFlight = (async (): Promise<BridgeSshSecrets> => {
    try {
      const payload = await resolveEnvSecret({
        slug: 'bridge_ssh',
        envLoader: envLoadBridgeSsh,
        required: true,
      });
      if (payload === null) {
        throw new Error(`Required env vars for slug 'bridge_ssh' are missing`);
      }
      cache = {
        privateKey: payload.privkey,
        publicKey: payload.pubkey,
        fingerprint: payload.fingerprint,
      };
      return cache;
    } finally {
      cacheInFlight = null;
    }
  })();

  return cacheInFlight;
}

export function resetBridgeSshConfigForTests(): void {
  cache = null;
  cacheInFlight = null;
}
