import { Module } from '@nestjs/common';
import { LoggerModule } from 'src/logger/logger.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { RegionAssignmentService } from './region-assignment.service';
import { RegionsBootstrapService } from './regions-bootstrap.service';
import { RegionsController } from './regions.controller';
import { RegionsService } from './regions.service';

@Module({
  imports: [PrismaModule, LoggerModule.forRoot()],
  controllers: [RegionsController],
  providers: [RegionsService, RegionAssignmentService, RegionsBootstrapService],
  exports: [RegionsService, RegionAssignmentService],
})
export class RegionsModule {}
