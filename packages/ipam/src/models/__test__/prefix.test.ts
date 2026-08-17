import { Prefix, PrefixStatus } from '../prefix';

describe('Prefix.getFirstAvailableIp last-address handling', () => {
  describe('non-pool IPv4', () => {
    const config = {
      id: 'p1',
      prefix: '10.0.0.0/30',
      status: PrefixStatus.Active,
      isPool: false,
    };

    it('skips the network address and returns the first host', () => {
      const prefix = new Prefix(config);
      expect(prefix.getFirstAvailableIp([])).toBe('10.0.0.1');
    });

    it('never returns the broadcast address (last address excluded)', () => {
      const prefix = new Prefix(config);
      expect(prefix.getFirstAvailableIp(['10.0.0.1', '10.0.0.2'])).toBeNull();
    });
  });

  describe('isPool IPv4', () => {
    const config = {
      id: 'p2',
      prefix: '10.0.0.0/30',
      status: PrefixStatus.Active,
      isPool: true,
    };

    it('starts at the network address', () => {
      const prefix = new Prefix(config);
      expect(prefix.getFirstAvailableIp([])).toBe('10.0.0.0');
    });

    it('returns the final (broadcast) address when it is the only one free', () => {
      const prefix = new Prefix(config);
      expect(prefix.getFirstAvailableIp(['10.0.0.0', '10.0.0.1', '10.0.0.2'])).toBe('10.0.0.3');
    });

    it('returns null only when the full range is allocated', () => {
      const prefix = new Prefix(config);
      expect(prefix.getFirstAvailableIp(['10.0.0.0', '10.0.0.1', '10.0.0.2', '10.0.0.3'])).toBeNull();
    });
  });

  describe('IPv6', () => {
    const config = {
      id: 'p3',
      prefix: '2001:0db8:0000:0000:0000:0000:0000:0000/126',
      status: PrefixStatus.Active,
      isPool: false,
    };

    it('returns the final address when it is the only one free', () => {
      const prefix = new Prefix(config);
      expect(prefix.getFirstAvailableIp(['2001:db8::', '2001:db8::1', '2001:db8::2'])).toBe(
        '2001:0db8:0000:0000:0000:0000:0000:0003',
      );
    });

    it('returns null only when the full range is allocated', () => {
      const prefix = new Prefix(config);
      expect(prefix.getFirstAvailableIp(['2001:db8::', '2001:db8::1', '2001:db8::2', '2001:db8::3'])).toBeNull();
    });
  });
});
