import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { getErrorMessage } from '@repo/utils';
import type { RedisClient, RedisClientGroup, RedisInfo, RedisScan, RedisValue } from '../contract';
import { RedisConnectionsService } from './redis-connections.service';

@Injectable()
export class RedisService {
  private readonly log = new Logger(RedisService.name);

  private static readonly COLLECTION_CAP = 500;

  constructor(private readonly connections: RedisConnectionsService) {}

  private get(): Redis {
    return this.connections.client('view');
  }

  async probe(): Promise<boolean> {
    try {
      return (await this.get().ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async info(): Promise<RedisInfo> {
    const c = this.get();
    const dbsize = await c.dbsize();
    const raw = await c.info();
    const parsed = parseInfo(raw);
    const pick = [
      'redis_version',
      'redis_mode',
      'os',
      'role',
      'tcp_port',
      'uptime_in_seconds',
      'connected_clients',
      'maxclients',
      'total_connections_received',
      'rejected_connections',
      'used_memory_human',
      'maxmemory_human',
      'mem_fragmentation_ratio',
      'evicted_keys',
      'expired_keys',
      'instantaneous_ops_per_sec',
      'total_commands_processed',
      'keyspace_hits',
      'keyspace_misses',
    ];
    const server: Record<string, string> = {};
    for (const k of pick) if (parsed[k] !== undefined) server[k] = parsed[k];

    let clients: RedisClientGroup[] = [];
    try {
      const listRaw = await c.call('CLIENT', 'LIST');
      clients = parseClientList(String(listRaw));
    } catch (error) {
      this.log.warn(`client list failed: ${getErrorMessage(error)}`);
    }

    return { dbsize, server, clients };
  }

  async scan(cursor: string, match: string | undefined, count: number): Promise<RedisScan> {
    const c = this.get();
    const [next, keys] = match
      ? await c.scan(cursor, 'MATCH', match, 'COUNT', count)
      : await c.scan(cursor, 'COUNT', count);
    const typed = await Promise.all(keys.map(async (key) => ({ key, type: await c.type(key) })));
    return { cursor: next, keys: typed };
  }

  async value(key: string): Promise<RedisValue> {
    const c = this.get();
    const type = await c.type(key);
    const ttl = await c.ttl(key);
    const cap = RedisService.COLLECTION_CAP;

    if (type === 'none') {
      return { key, type, ttl, kind: 'none', value: null, truncated: false, length: 0 };
    }
    if (type === 'string') {
      const v = await c.get(key);
      return { key, type, ttl, kind: 'string', value: v, truncated: false, length: 1 };
    }
    if (type === 'hash') {
      const length = await c.hlen(key);
      const map: Record<string, string> = {};
      let count = 0;
      let cur = '0';
      do {
        const [next, flat] = await c.hscan(key, cur, 'COUNT', 200);
        for (let i = 0; i < flat.length && count < cap; i += 2) {
          map[flat[i]] = flat[i + 1];
          count++;
        }
        cur = next;
      } while (cur !== '0' && count < cap);
      return { key, type, ttl, kind: 'hash', value: map, truncated: count < length, length };
    }
    if (type === 'list') {
      const length = await c.llen(key);
      const value = await c.lrange(key, 0, cap - 1);
      return { key, type, ttl, kind: 'list', value, truncated: length > value.length, length };
    }
    if (type === 'set') {
      const length = await c.scard(key);
      const members: string[] = [];
      let cur = '0';
      do {
        const [next, batch] = await c.sscan(key, cur, 'COUNT', 200);
        for (const m of batch) if (members.length < cap) members.push(m);
        cur = next;
      } while (cur !== '0' && members.length < cap);
      return { key, type, ttl, kind: 'set', value: members, truncated: members.length < length, length };
    }
    if (type === 'zset') {
      const length = await c.zcard(key);
      const scored: { member: string; score: string }[] = [];
      let cur = '0';
      do {
        const [next, flat] = await c.zscan(key, cur, 'COUNT', 200);
        for (let i = 0; i < flat.length && scored.length < cap; i += 2) {
          scored.push({ member: flat[i], score: flat[i + 1] });
        }
        cur = next;
      } while (cur !== '0' && scored.length < cap);
      return { key, type, ttl, kind: 'zset', value: scored, truncated: scored.length < length, length };
    }
    if (type === 'stream') {
      const length = await c.xlen(key);
      const entries = await c.xrange(key, '-', '+', 'COUNT', cap);
      const shaped = entries.map(([id, flat]) => {
        const fields: Record<string, string> = {};
        for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
        return { id, fields };
      });
      return { key, type, ttl, kind: 'stream', value: shaped, truncated: length > shaped.length, length };
    }
    return { key, type, ttl, kind: 'none', value: null, truncated: false, length: 0 };
  }
}

function parseInfo(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function parseClientList(raw: string): RedisClientGroup[] {
  const groups = new Map<string, RedisClient[]>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields: Record<string, string> = {};
    for (const pair of line.split(' ')) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      fields[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    const client: RedisClient = {
      id: fields.id ?? '',
      addr: fields.addr ?? '',
      ageSeconds: Number(fields.age ?? 0) || 0,
      idleSeconds: Number(fields.idle ?? 0) || 0,
      db: Number(fields.db ?? 0) || 0,
      cmd: fields.cmd ?? '',
    };
    const label = fields.name || fields['lib-name'] || (fields.addr ?? '').split(':')[0] || 'unknown';
    const bucket = groups.get(label) ?? [];
    bucket.push(client);
    groups.set(label, bucket);
  }
  return [...groups.entries()]
    .map(([label, clients]) => ({
      label,
      count: clients.length,
      clients: clients.sort((a, b) => b.ageSeconds - a.ageSeconds),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
