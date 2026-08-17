import { Global, Module } from '@nestjs/common';
import { ActiveRecordContextProvider } from 'src/common/context/active-record-context.provider';
import { ContextService } from 'src/common/context/context.service';

@Global()
@Module({
  providers: [ContextService, ActiveRecordContextProvider],
  exports: [ContextService, ActiveRecordContextProvider],
})
export class ContextModule {}
