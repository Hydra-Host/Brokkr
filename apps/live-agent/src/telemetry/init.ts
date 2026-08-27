import { context, defaultTextMapGetter, ROOT_CONTEXT, trace, type Context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { getErrorMessage } from '@repo/utils';
import { makeLogger } from '../logger';
import { AGENT_VERSION } from '../version';
import { RelaySpanExporter, type TraceSender } from './relay-exporter';

const logger = makeLogger('telemetry');

const propagator = new W3CTraceContextPropagator();

let provider: BasicTracerProvider | undefined;

export interface AgentTelemetryOptions {
  enabled: boolean;
  deviceId: string;
  zoneId: string;
  sender: TraceSender;
}

export function initAgentTelemetry(options: AgentTelemetryOptions): void {
  // Registered even when disabled so a bridge-supplied traceparent flows through the noop tracer and log lines stamp trace ids.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  if (!options.enabled) return;

  try {
    const resource = resourceFromAttributes({
      'service.name': 'brokkr-agent',
      'service.version': AGENT_VERSION,
      device_id: options.deviceId,
      zone: options.zoneId,
    });
    provider = new BasicTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(new RelaySpanExporter(options.sender), {
          maxExportBatchSize: 256,
          scheduledDelayMillis: 5_000,
        }),
      ],
    });
    trace.setGlobalTracerProvider(provider);
    logger.info('agent tracing enabled', { exporter: 'bridge-relay' });
  } catch (error) {
    provider = undefined;
    logger.warn('agent tracing init failed; continuing without traces', {
      error: getErrorMessage(error),
    });
  }
}

/** Called before the connection manager stops (pool transports still healthy); the race keeps a wedged export from delaying exit. */
export async function shutdownAgentTelemetry(timeoutMs = 2_000): Promise<void> {
  if (provider === undefined) return;
  const active = provider;
  provider = undefined;
  try {
    await Promise.race([
      active.forceFlush().then(() => active.shutdown()),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs).unref();
      }),
    ]);
  } catch (error) {
    logger.warn('agent tracing shutdown failed', {
      error: getErrorMessage(error),
    });
  }
}

export function extractDispatchContext(traceparent?: string, tracestate?: string): Context {
  if (!traceparent) return ROOT_CONTEXT;
  const carrier: Record<string, string> = { traceparent };
  if (tracestate) carrier['tracestate'] = tracestate;
  return propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
}
