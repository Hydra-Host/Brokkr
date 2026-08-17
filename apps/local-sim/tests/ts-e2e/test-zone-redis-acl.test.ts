/**
 * Zone Redis ACL e2e — verifies the opt-in per-zone Redis ACL feature
 * (REDIS_ACL_MANAGEMENT_ENABLED, on by default in the sim via
 * devenv/modules/redis-acl.nix) against the live local stack:
 *
 *   - creating a zone via the API returns a show-once credential and creates
 *     a `brokkr-spoke-<zoneId>` ACL user scoped to `~<zoneId>:* ~results:*`
 *   - the credential can write/read inside its zone namespace and the shared
 *     results namespace, but is denied other zones' keys and admin/dangerous
 *     commands
 *   - rotating replaces the password (old one stops authenticating)
 *   - deleting the zone removes the ACL user
 *
 * Non-destructive to the seeded fleet: operates only on a throwaway zone it
 * creates itself. Skips (rather than fails) when the hub runs with the flag
 * off — the create response then carries no redisCredential.
 */

import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HubAdminClient } from './hub-client';

const REDIS_URL = process.env.BRIDGE_REDIS_URL ?? 'redis://127.0.0.1:6379';

interface ShownCredential {
  username: string;
  password: string;
}

let hub: HubAdminClient;
let adminRedis: Redis;
let zoneId: string;
let credential: ShownCredential | null = null;
let zoneDeleted = false;

function scopedClient(username: string, password: string): Redis {
  const url = new URL(REDIS_URL);
  return new Redis({
    host: url.hostname,
    port: url.port ? parseInt(url.port, 10) : 6379,
    username,
    password,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
}

async function aclUsers(): Promise<string[]> {
  return (await adminRedis.call('ACL', 'USERS')) as string[];
}

beforeAll(async () => {
  hub = new HubAdminClient();
  await hub.signIn();
  adminRedis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

  const res = await hub.createZone({
    name: `e2e-redis-acl-${Date.now()}`,
    primaryAddress: {
      addressLineOne: '1 Test Way',
      city: 'Testville',
      stateOrProvince: 'CA',
      postalCode: '94102',
      countryCode: 'US',
      latitude: 37.7749,
      longitude: -122.4194,
      timezone: 'America/Los_Angeles',
    },
    contacts: [
      {
        name: 'E2E Bot',
        title: 'Test',
        email: 'e2e@brokkr.local',
        phone: '+12125551234',
        contactType: 'Main',
        isShippingContact: true,
      },
    ],
  });
  if (res.status !== 201) {
    throw new Error(`zone create failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  const body = res.body as { id: string; redisCredential?: ShownCredential };
  zoneId = body.id;
  credential = body.redisCredential ?? null;
}, 60_000);

afterAll(async () => {
  // Best-effort cleanup for early-failure paths; the final test normally
  // deletes the zone already.
  if (zoneId && !zoneDeleted) {
    await hub.deleteZone(zoneId).catch(() => undefined);
  }
  adminRedis?.disconnect();
});

describe('zone redis acl', () => {
  it('zone create returns a show-once credential', (ctx) => {
    if (credential === null) {
      // Hub is running with REDIS_ACL_MANAGEMENT_ENABLED off (redisAcl.enable=false).
      ctx.skip();
    }
    expect(credential!.username).toBe(`brokkr-spoke-${zoneId}`);
    expect(credential!.password.length).toBeGreaterThanOrEqual(24);
  });

  it('ACL user exists and is scoped to the zone + results namespaces', async (ctx) => {
    if (credential === null) ctx.skip();

    expect(await aclUsers()).toContain(credential!.username);

    const details = await adminRedis.call('ACL', 'GETUSER', credential!.username);
    const flat = JSON.stringify(details);
    expect(flat).toContain(`~${zoneId}:*`);
    expect(flat).toContain('~results:*');
  });

  it('credential can read/write its own namespace and results, nothing else', async (ctx) => {
    if (credential === null) ctx.skip();

    const client = scopedClient(credential!.username, credential!.password);
    try {
      await client.connect();

      // Allowed: own zone prefix + shared results namespace.
      await expect(client.set(`${zoneId}:e2e:probe`, 'ok', 'EX', 60)).resolves.toBe('OK');
      await expect(client.get(`${zoneId}:e2e:probe`)).resolves.toBe('ok');
      await expect(client.set('results:e2e:probe', 'ok', 'EX', 60)).resolves.toBe('OK');

      // Denied: another zone's namespace.
      await expect(client.set('00000000-0000-0000-0000-999999999999:e2e:probe', 'nope')).rejects.toThrow(/NOPERM/i);

      // Denied: admin (+@admin) and dangerous (-@dangerous) commands.
      await expect(client.call('CONFIG', 'GET', 'maxmemory')).rejects.toThrow(/NOPERM/i);
      await expect(client.call('FLUSHALL')).rejects.toThrow(/NOPERM/i);
      await expect(client.call('ACL', 'USERS')).rejects.toThrow(/NOPERM/i);

      // Explicitly re-granted despite @dangerous: KEYS and INFO.
      await expect(client.call('KEYS', `${zoneId}:e2e:*`)).resolves.toBeDefined();
      await expect(client.call('INFO', 'server')).resolves.toBeDefined();
    } finally {
      client.disconnect();
    }
  });

  it('rotate returns a fresh working credential and revokes the old password', async (ctx) => {
    if (credential === null) ctx.skip();

    const res = await hub.rotateZoneRedisCredential(zoneId);
    expect(res.status).toBe(201);
    const rotated = res.body as ShownCredential;
    expect(rotated.username).toBe(credential!.username);
    expect(rotated.password).not.toBe(credential!.password);

    const fresh = scopedClient(rotated.username, rotated.password);
    try {
      await fresh.connect();
      await expect(fresh.set(`${zoneId}:e2e:rotated`, 'ok', 'EX', 60)).resolves.toBe('OK');
    } finally {
      fresh.disconnect();
    }

    const stale = scopedClient(credential!.username, credential!.password);
    // ioredis emits the WRONGPASS as an out-of-band 'error' event and rejects
    // in-flight commands with "Connection is closed." — swallow the event and
    // accept either message.
    stale.on('error', () => undefined);
    try {
      await expect(stale.connect().then(() => stale.ping())).rejects.toThrow(/WRONGPASS|NOAUTH|auth|closed/i);
    } finally {
      stale.disconnect();
    }

    credential = rotated;
  });

  it('zone delete removes the ACL user', async (ctx) => {
    if (credential === null) ctx.skip();

    const res = await hub.deleteZone(zoneId);
    expect(res.status).toBe(204);
    zoneDeleted = true;

    expect(await aclUsers()).not.toContain(credential!.username);
  });
});
