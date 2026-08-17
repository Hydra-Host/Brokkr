import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { contract } from '../contract';
import { AuditService } from './audit.service';

@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @TsRestHandler(contract.listAuditEvents)
  list() {
    return tsRestHandler(contract.listAuditEvents, async ({ query }) => ({
      status: 200 as const,
      body: this.audit.list(query),
    }));
  }
}
