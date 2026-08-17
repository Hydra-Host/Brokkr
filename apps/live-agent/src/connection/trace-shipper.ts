import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';

import { TraceBatchSchema } from '../gen/brokkr/agent/v1/agent_pb';
import type { TraceSender } from '../telemetry/relay-exporter';
import { hashDeviceId } from './hash';
import type { TransportPool } from './pool';

export function createTraceSender(args: { deviceId: string; pool: TransportPool }): TraceSender {
  return async (otlpTraces: Uint8Array): Promise<void> => {
    const addresses = [...args.pool.listAddresses()].sort();
    if (addresses.length === 0) throw new Error('no bridge transports available');
    const start = hashDeviceId(args.deviceId) % addresses.length;
    let lastError: unknown;
    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[(start + i) % addresses.length];
      if (address === undefined) continue;
      try {
        await args.pool
          .getClient(address)
          .reportTraces(create(TraceBatchSchema, { deviceId: args.deviceId, otlpTraces }));
        return;
      } catch (error) {
        if (
          error instanceof ConnectError &&
          (error.code === Code.ResourceExhausted || error.code === Code.Unimplemented)
        ) {
          // Bridge-side cap or rollout skew: drop rather than duplicate via another bridge.
          return;
        }
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}
