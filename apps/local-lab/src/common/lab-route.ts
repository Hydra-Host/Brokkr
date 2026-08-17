import { SetMetadata } from '@nestjs/common';

import type { LabExposure } from './lab-exposure';

export const LAB_ROUTE = 'lab:route';

export interface LabRouteOptions {
  exposure?: LabExposure;
  audit?: boolean;
}

// must sit below @TsRestHandler: a multi-route handler copies metadata at decoration time, so a tag above is dropped
export const LabRoute = (opts: LabRouteOptions) => SetMetadata(LAB_ROUTE, opts);
