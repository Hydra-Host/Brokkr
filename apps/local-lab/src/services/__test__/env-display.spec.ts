import { displayEnvValue } from '../process-env.service';

const BRIDGE_AT_REST_KEY = 'not-a-real-at-rest-key-just-a-test-fixture';

describe('displayEnvValue', () => {
  describe('masked default (reveal=false)', () => {
    it('masks secret-keyed values and DSN userinfo, passes plain values through', () => {
      expect(displayEnvValue('BRIDGE_AT_REST_KEY', BRIDGE_AT_REST_KEY, false)).toBe('***');
      expect(displayEnvValue('PG_PASSWORD', 'hunter2', false)).toBe('***');
      expect(displayEnvValue('DATABASE_URL', 'postgresql://brokkr:password@db:5432/brokkr', false)).toBe(
        'postgresql://***@db:5432/brokkr',
      );
      expect(displayEnvValue('LOG_LEVEL', 'debug', false)).toBe('debug');
    });
  });

  describe('reveal=true', () => {
    it('NEVER returns a secret-keyed value raw — fingerprints it instead', () => {
      const shown = displayEnvValue('BRIDGE_AT_REST_KEY', BRIDGE_AT_REST_KEY, true);
      expect(shown).not.toContain(BRIDGE_AT_REST_KEY);
      expect(shown).not.toContain(BRIDGE_AT_REST_KEY.slice(0, 12));
      expect(shown).toMatch(/^\*\*\*sha256:[0-9a-f]{8} \(len \d+\)$/);
      expect(shown).toContain(`(len ${BRIDGE_AT_REST_KEY.length})`);
    });

    it('fingerprint is deterministic and distinguishes different secrets', () => {
      expect(displayEnvValue('API_KEY', 'aaa', true)).toBe(displayEnvValue('API_KEY', 'aaa', true));
      expect(displayEnvValue('API_KEY', 'aaa', true)).not.toBe(displayEnvValue('API_KEY', 'bbb', true));
    });

    it('reveals non-secret values in plaintext (the point of reveal)', () => {
      expect(displayEnvValue('LOG_LEVEL', 'debug', true)).toBe('debug');
      expect(displayEnvValue('HUB_REPO_PATH', '/home/op/hub', true)).toBe('/home/op/hub');
    });

    it('strips DSN userinfo even for non-secret-keyed vars (DATABASE_URL/REDIS_URL)', () => {
      const shown = displayEnvValue('DATABASE_URL', 'postgresql://brokkr:password@db:5432/brokkr', true);
      expect(shown).not.toContain('password');
      expect(shown).toBe('postgresql://***@db:5432/brokkr');
    });
  });
});
