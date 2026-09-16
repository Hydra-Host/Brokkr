import { SetMetadata } from '@nestjs/common';

import type { RouteCapability } from './lab-capability';

export const LAB_ROUTE = 'lab:route';
export const LAB_PUBLIC_ROUTE = 'lab:public-route';

export interface LabRouteOptions {
  capability?: RouteCapability;
  audit?: boolean;
}

// must sit below @TsRestHandler: a multi-route handler copies metadata at decoration time, so a tag above is dropped
export const LabRoute = (opts: LabRouteOptions) => SetMetadata(LAB_ROUTE, opts);

/** The one exemption from LabAuthGuard, for the readiness probe that cannot present a token.
 *  Pinned to a single handler by the route sweep — never add a second. */
export const PublicLabRoute = () => SetMetadata(LAB_PUBLIC_ROUTE, true);
