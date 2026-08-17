import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { SanitizationReportService } from './sanitization-report.service';

@Module({
  imports: [PrismaModule],
  providers: [SanitizationReportService],
  exports: [SanitizationReportService],
})
export class SanitizationReportModule {}
