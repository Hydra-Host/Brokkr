import { Inject, Injectable } from '@nestjs/common';
import { SolLogReader, type DiagnosticsLogger, type SolLogList } from '@repo/lifecycle';
import { Logger } from 'src/common/decorators/logger.decorator';
import { REDIS_CLIENT } from 'src/common/redis';

export type { SolLogList as SolLogListReader } from '@repo/lifecycle';

@Injectable()
export class SolLogService extends SolLogReader {
  constructor(@Inject(REDIS_CLIENT) redis: SolLogList, @Logger(SolLogService.name) logger: DiagnosticsLogger) {
    super(redis, logger);
  }
}
