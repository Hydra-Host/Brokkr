
import { describe, expect, it } from 'vitest';

import { JobIdService } from '../job-id.service';

describe('JobIdService.extractClientIp — trusted peer precedence', () => {
  const service = new JobIdService();

  it('returns the framework-resolved peer address (remoteAddr)', () => {
    expect(service.extractClientIp({}, '192.168.1.100')).toBe('192.168.1.100');
  });

  it('spoofed X-Forwarded-For does not override the real peer address', () => {
    expect(service.extractClientIp({ 'X-Forwarded-For': '203.0.113.9' }, '192.168.1.100')).toBe('192.168.1.100');
  });

  it('spoofed multi-hop X-Forwarded-For does not override the real peer address', () => {
    expect(service.extractClientIp({ 'X-Forwarded-For': '203.0.113.9, 10.0.0.1, 172.16.0.1' }, '192.168.1.100')).toBe(
      '192.168.1.100',
    );
  });

  it('peer address wins over every proxy header', () => {
    expect(
      service.extractClientIp(
        {
          'X-Forwarded-For': '203.0.113.9',
          'X-Real-IP': '10.0.0.1',
          'CF-Connecting-IP': '172.16.0.1',
          'X-Forwarded-Host': '203.0.113.1',
        },
        '192.168.1.100',
      ),
    ).toBe('192.168.1.100');
  });

  it('falls back to X-Forwarded-For first hop only when no peer address', () => {
    expect(service.extractClientIp({ 'X-Forwarded-For': '192.168.1.100, 10.0.0.1' }, null)).toBe('192.168.1.100');
  });

  it('falls back to X-Real-IP when no peer address and XFF absent', () => {
    expect(service.extractClientIp({ 'X-Real-IP': '192.168.1.100' }, null)).toBe('192.168.1.100');
  });

  it('falls back to CF-Connecting-IP when no peer address', () => {
    expect(service.extractClientIp({ 'CF-Connecting-IP': '192.168.1.100' }, null)).toBe('192.168.1.100');
  });

  it('falls back to X-Forwarded-Host when no peer address', () => {
    expect(service.extractClientIp({ 'X-Forwarded-Host': '192.168.1.100' }, null)).toBe('192.168.1.100');
  });

  it('"unknown" sentinel when no peer address and no headers', () => {
    expect(service.extractClientIp({}, null)).toBe('unknown');
  });

  it('whitespace-only remoteAddr falls back to header hints', () => {
    expect(service.extractClientIp({ 'X-Real-IP': '192.168.1.100' }, '   ')).toBe('192.168.1.100');
  });
});

describe('JobIdService — AsyncLocalStorage run/current/set lifecycle', () => {
  it('run() exposes the job id to current() inside the callback', () => {
    const service = new JobIdService();
    let observed = '';
    service.run('job-abc', () => {
      observed = service.current();
    });
    expect(observed).toBe('job-abc');
  });

  it('current() outside any run() frame returns ""', () => {
    const service = new JobIdService();
    expect(service.current()).toBe('');
  });

  it('set() inside a run() frame mutates the active store', () => {
    const service = new JobIdService();
    let observed = '';
    service.run('initial', () => {
      service.set('updated');
      observed = service.current();
    });
    expect(observed).toBe('updated');
  });

  it('frames are isolated: outer current() unaffected by inner run()', () => {
    const service = new JobIdService();
    let inner = '';
    let outer = '';
    service.run('outer', () => {
      service.run('inner', () => {
        inner = service.current();
      });
      outer = service.current();
    });
    expect(inner).toBe('inner');
    expect(outer).toBe('outer');
  });
});
