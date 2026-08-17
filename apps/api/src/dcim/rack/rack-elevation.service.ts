import { Injectable } from '@nestjs/common';
import { RackRecord } from './rack.record';

@Injectable()
export class RackElevationService {
  async getElevation(rackId: string, face?: string) {
    return RackRecord.getElevation(rackId, face);
  }
}
