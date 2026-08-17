import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CloudInitTemplatesController } from './cloud-init-templates.controller';
import { CloudInitTemplatesService } from './cloud-init-templates.service';

@Module({
  imports: [PrismaModule],
  controllers: [CloudInitTemplatesController],
  providers: [CloudInitTemplatesService],
  exports: [CloudInitTemplatesService],
})
export class CloudInitTemplatesModule {}
