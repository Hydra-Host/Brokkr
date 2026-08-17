import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { ConfigAtomWriter, type AtomWriteResult } from 'src/common/redis';
import { DNS_RECORDS_KEY, TTL_DNS_RECORDS_SECONDS } from 'src/common/redis/redis-keys';
import { LoggerService } from 'src/logger/logger.service';
import { DnsRecordsAtomSchema, type DnsRecordsAtom } from './dns-records-atom.schema';

@Injectable()
export class DnsRecordsRedisWriterService {
  constructor(
    private readonly atomWriter: ConfigAtomWriter,
    @Logger(DnsRecordsRedisWriterService.name)
    private readonly logger: LoggerService,
  ) {}

  async set(zoneId: string, value: DnsRecordsAtom): Promise<AtomWriteResult> {
    const result = await this.atomWriter.writeAtomJson(
      zoneId,
      DNS_RECORDS_KEY,
      value,
      DnsRecordsAtomSchema,
      TTL_DNS_RECORDS_SECONDS,
      {
        request_id: null,
      },
    );
    if (!result.written) {
      this.logger.log(`Skipped DNS records write (${result.reason}) for zone ${zoneId}`);
      return result;
    }
    this.logger.log(`Wrote DNS records envelope for zone ${zoneId} (domains=${value.domains.length})`);
    return result;
  }

  async clear(zoneId: string): Promise<void> {
    await this.atomWriter.delKey(zoneId, DNS_RECORDS_KEY);
    this.logger.log(`Cleared DNS records for zone ${zoneId}`);
  }
}
