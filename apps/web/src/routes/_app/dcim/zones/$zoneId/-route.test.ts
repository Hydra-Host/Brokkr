import { shouldRetryZoneLoad, ZoneLoadError } from './route';

describe('shouldRetryZoneLoad', () => {
  it('fails fast on a 4xx ZoneLoadError (non-retryable client error)', () => {
    expect(shouldRetryZoneLoad(0, new ZoneLoadError(404))).toBe(false);
  });

  it('treats status 400 as the inclusive lower bound of the fail-fast range', () => {
    expect(shouldRetryZoneLoad(0, new ZoneLoadError(400))).toBe(false);
  });

  it('retries a 5xx ZoneLoadError while under the attempt cap, then gives up', () => {
    expect(shouldRetryZoneLoad(0, new ZoneLoadError(503))).toBe(true);
    expect(shouldRetryZoneLoad(2, new ZoneLoadError(503))).toBe(true);
    expect(shouldRetryZoneLoad(3, new ZoneLoadError(503))).toBe(false);
  });

  it('treats status 500 as retryable (just outside the fail-fast range)', () => {
    expect(shouldRetryZoneLoad(0, new ZoneLoadError(500))).toBe(true);
  });

  it('retries a generic transport error until the attempt cap', () => {
    expect(shouldRetryZoneLoad(0, new Error('network down'))).toBe(true);
    expect(shouldRetryZoneLoad(2, new Error('network down'))).toBe(true);
    expect(shouldRetryZoneLoad(3, new Error('network down'))).toBe(false);
  });
});
