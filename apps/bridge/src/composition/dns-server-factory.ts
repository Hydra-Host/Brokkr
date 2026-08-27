import type { DnsServerDeps } from '../startup/startup-services.js';

import { getErrorMessage } from '../common/error-utils.js';
import { createIoredisDriverFactory } from '../common/redis/redis-client/ioredis-driver.js';
import { RedisClient } from '../common/redis/redis-client/redis.client.js';
import { loadRedisConfig } from '../common/redis/redis-client/redis.config.js';
import { readAtom } from '../device-record/atom/atom-fetcher.js';
import { DnsConfigReaderService } from '../dns/dns-config-reader.service.js';
import { DNS_RECORDS_KEY, DnsRecordsLookup } from '../dns/dns-records-reader.js';
import { DnsRecordsAtomValueSchema } from '../dns/dns-records-reader.schema.js';
import { dnsServeCidrs, dnsServeInterfaceIps, unionInterfaceIps } from '../dns/dns-serve-interfaces.js';
import { DnsServerService, type DnsRecordsReadResult } from '../dns/dns-server.service.js';
import { defaultDnsConfig, type DnsConfig } from '../dns/dns.config.js';
import type { InterfaceIp } from '../dns/interfaces.js';
import { ContextLogger, logInfo } from '../logger/logger.service.js';

import { getAtomServedCidrs, getAtomServedIps } from './atom-served-ips-holder.js';

export function buildDnsServerDeps(env: NodeJS.ProcessEnv = process.env): DnsServerDeps {
  const config = defaultDnsConfig(env);
  return {
    config,
    createService: (): DnsServerService => {
      const zonePrefix = (env.BROKKR_ZONE_ID ?? '').trim();
      let configReader: DnsConfigReaderService | undefined;
      let readRecords: ((jobId: string) => Promise<DnsRecordsReadResult | null>) | undefined;
      let onStop: (() => Promise<void>) | undefined;
      // Updated from the DNS reconcile's prefix-override read; no atoms -> empty -> fail-closed.
      let dnsServeIps: InterfaceIp[] = [];
      let dnsServeCidrList: string[] = [];

      if (zonePrefix !== '') {
        const redisConfig = { ...loadRedisConfig(env), prefix: zonePrefix };
        const client = new RedisClient(redisConfig, createIoredisDriverFactory(redisConfig, 'redis:dns'));
        const logger = new ContextLogger();
        configReader = new DnsConfigReaderService(client, logger);
        void logInfo(`DNS composition: zone-scoped config reader bound to prefix '${zonePrefix}'`);

        readRecords = async (jobId: string): Promise<DnsRecordsReadResult | null> => {
          let atom;
          try {
            atom = await readAtom(client, DNS_RECORDS_KEY, DnsRecordsAtomValueSchema, { jobId });
          } catch (error) {
            void logger.warning(`Failed to read DNS records atom: ${getErrorMessage(error)}`, { jobId });
            return null;
          }
          if (atom === null) return null;
          const domains = new Set<string>(atom.domains.map((d) => d.name.toLowerCase()));
          return { lookup: new DnsRecordsLookup(atom), domains };
        };
        onStop = () => client.close();
      }

      return new DnsServerService({
        config,
        listInterfaces: () => unionInterfaceIps(getAtomServedIps(), dnsServeIps),
        listServedCidrs: () => [...new Set([...getAtomServedCidrs(), ...dnsServeCidrList])],
        configReader,
        readRecords,
        onPrefixOverrides: (overrides) => {
          dnsServeIps = dnsServeInterfaceIps(overrides);
          dnsServeCidrList = dnsServeCidrs(overrides);
        },
        onStop,
      });
    },
  };
}

export type { DnsConfig };
