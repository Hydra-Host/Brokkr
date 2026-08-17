import { emitTelemetryLog } from '@repo/telemetry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '../logger.service';

vi.mock('@repo/telemetry', () => ({ emitTelemetryLog: vi.fn() }));

function buildLogger(requestId?: string): LoggerService {
  const contextService = { requestId } as never;
  const logger = new LoggerService(contextService);
  logger.setContext('SpecContext');
  return logger;
}

describe('LoggerService telemetry forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('LOG_LEVEL', 'verbose');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('forwards each level with the raw message and structured correlation', () => {
    const logger = buildLogger('req-1');
    logger.log('hello');
    expect(emitTelemetryLog).toHaveBeenLastCalledWith('brokkr-hub', 'info', 'hello', {
      'brokkr.logger_context': 'SpecContext',
      'brokkr.correlation_id': 'req-1',
      'exception.stacktrace': undefined,
    });
    logger.warn('careful', 'plan-7');
    expect(emitTelemetryLog).toHaveBeenLastCalledWith('brokkr-hub', 'warn', 'careful', {
      'brokkr.logger_context': 'SpecContext',
      'brokkr.correlation_id': 'plan-7',
      'exception.stacktrace': undefined,
    });
    logger.debug('details');
    expect(emitTelemetryLog).toHaveBeenLastCalledWith('brokkr-hub', 'debug', 'details', {
      'brokkr.logger_context': 'SpecContext',
      'brokkr.correlation_id': 'req-1',
      'exception.stacktrace': undefined,
    });
    logger.verbose('chatty');
    expect(emitTelemetryLog).toHaveBeenLastCalledWith('brokkr-hub', 'verbose', 'chatty', {
      'brokkr.logger_context': 'SpecContext',
      'brokkr.correlation_id': 'req-1',
      'exception.stacktrace': undefined,
    });
  });

  it('forwards error with the stack trace attribute', () => {
    const logger = buildLogger();
    logger.error('boom', 'stack-lines', 'plan-9');
    expect(emitTelemetryLog).toHaveBeenLastCalledWith('brokkr-hub', 'error', 'boom', {
      'brokkr.logger_context': 'SpecContext',
      'brokkr.correlation_id': 'plan-9',
      'exception.stacktrace': 'stack-lines',
    });
  });

  it('respects the level allowlist — a suppressed level never reaches telemetry', () => {
    vi.stubEnv('LOG_LEVEL', 'warn');
    const logger = buildLogger();
    logger.log('suppressed');
    logger.debug('suppressed');
    expect(emitTelemetryLog).not.toHaveBeenCalled();
    logger.warn('passes');
    expect(emitTelemetryLog).toHaveBeenCalledOnce();
  });
});
