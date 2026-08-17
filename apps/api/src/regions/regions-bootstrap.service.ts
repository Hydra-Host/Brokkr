import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { RegionAssignmentService } from './region-assignment.service';
import { RegionsService } from './regions.service';

@Injectable()
export class RegionsBootstrapService implements OnApplicationBootstrap {
  constructor(
    private readonly regionsService: RegionsService,
    private readonly regionAssignment: RegionAssignmentService,
    @Logger(RegionsBootstrapService.name) private readonly logger: LoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    let seeded: number;
    try {
      seeded = await this.regionsService.seedRegionsIfEmpty();
    } catch (error) {
      this.logger.error(`Region bootstrap failed before writes; keeping existing data: ${getErrorMessage(error)}`);
      return;
    }
    if (seeded === 0) return;

    try {
      const assignments = await this.regionAssignment.recomputeAllZones();
      this.logger.log(
        `Region bootstrap: ${seeded} regions seeded; zones ${assignments.assigned}/${assignments.total} assigned (${assignments.unassigned} without coordinates)`,
      );
    } catch (error) {
      this.logger.error(
        `Region bootstrap seeded ${seeded} regions but zone reassignment failed; assignments may be stale: ${getErrorMessage(error)}`,
      );
    }
  }
}
