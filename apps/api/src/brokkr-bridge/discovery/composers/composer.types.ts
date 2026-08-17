import type { CollectorContext, DeviceMutation } from '../collectors/collector.types';

export interface Composer {
  name: string;
  compose(ctx: CollectorContext, buffered: DeviceMutation): Promise<DeviceMutation>;
}
