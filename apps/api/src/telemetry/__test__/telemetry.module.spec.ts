import { shutdownTelemetry } from '@repo/telemetry';
import { describe, expect, it, vi } from 'vitest';
import { TelemetryModule } from '../telemetry.module';

vi.mock('@repo/telemetry', () => ({
  shutdownTelemetry: vi.fn(() => Promise.resolve()),
}));

describe('TelemetryModule', () => {
  it('flushes buffered spans on application shutdown', async () => {
    await new TelemetryModule().onApplicationShutdown();
    expect(shutdownTelemetry).toHaveBeenCalledExactlyOnceWith();
  });
});
