import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { formatZone } from './heartbeat-monitor.constants';
import { ZoneFlapDetectionService } from './zone-flap-detection.service';

@Injectable()
export class ZoneFlapAlertingService {
  constructor(
    private readonly flapDetectionService: ZoneFlapDetectionService,
    @Logger(ZoneFlapAlertingService.name) private readonly logger: LoggerService,
  ) {}

  async checkAndAlertIfFlapping(zoneId: string, zoneName?: string | null): Promise<boolean> {
    const zone = formatZone(zoneId, zoneName);

    try {
      // Episode seam: isNewFlappingEpisode (not detectZoneFlapping) so the
      // flap-episode counter fires on the live offline-transition path.
      const isFlapping = await this.flapDetectionService.isNewFlappingEpisode(zoneId, zoneName);

      if (isFlapping) {
        this.logger.warn(`Zone ${zone} is flapping — suppressing offline alert`);
      }

      return isFlapping;
    } catch (error) {
      this.logger.error(`Failed to process flapping check for zone ${zone}`, getErrorMessage(error));
      return false;
    }
  }
}
