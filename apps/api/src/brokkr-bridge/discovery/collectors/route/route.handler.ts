import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type RouteInput, routeSchema } from './route.schema';

@Injectable()
export class RouteHandler implements CollectorHandler<RouteInput> {
  readonly name = 'route' as const;
  readonly schema = routeSchema;

  async handle(_input: RouteInput): Promise<DeviceMutation> {
    return {};
  }
}
