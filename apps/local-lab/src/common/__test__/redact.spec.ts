import {
  PAYLOAD_BYTE_CAP,
  isSecretKey,
  looksLikeDsn,
  maskDsn,
  maskEmbeddedDsns,
  redactPayload,
  redactPayloadCapped,
  serializeAuditParams,
} from '../redact';

describe('isSecretKey', () => {
  it('matches the denylisted key fragments', () => {
    for (const key of [
      'SECRET',
      'HUB_TOKEN',
      'PG_PASSWORD',
      'passwd',
      'private_thing',
      'stripe_credential',
      'API_KEY',
      'apikey',
      'BRIDGE_AT_REST_KEY',
      'authorization',
      'passphrase',
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it('leaves non-secret keys alone', () => {
    for (const key of ['LOG_LEVEL', 'sql', 'keyboard', 'name', 'HUB_REPO_PATH']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  it.each([
    ['user_data', true],
    ['userData', true],
    ['userdata', true],
    ['pubkeys', true],
    ['pubkey', true],
    ['pub_key', true],
    ['authorized_keys', true],
    ['host_keys', true],
    ['bmc_pass', true],
    ['bmcPass', true],
    ['DB_PASS', true],
    ['password_hash', true],
    ['server_token', true],
    ['ssh_key', true],
    ['cloudInit', true],
    ['cloud_init', true],
    ['cloud-init', true],
    ['cloudinit', true],
    ['passthrough', false],
    ['passthroughSupported', false],
    ['username', false],
    ['bmc_user', false],
    ['DATABASE_URL', false],
    ['REDIS_URL', false],
    ['hub', false],
  ])('classifies %s as secret=%s', (key, expected) => {
    expect(isSecretKey(key)).toBe(expected);
  });
});

describe('looksLikeDsn', () => {
  it.each([
    ['postgres://brokkr:s3cret@db.internal:5432/brokkr', true],
    ['redis://default:r3dis@cache.internal:6379/0', true],
    ['://brokkr:s3cret@db.internal/x', true],
    ['postgresql://db.internal:5432/brokkr', false],
    ['brokkr@db.internal', false],
    ['select 1', false],
  ])('classifies %s as dsn=%s', (value, expected) => {
    expect(looksLikeDsn(value)).toBe(expected);
  });
});

describe('maskDsn', () => {
  it.each([
    ['postgres://brokkr:s3cret@db.internal:5432/brokkr', 'postgres://***@db.internal:5432/brokkr'],
    ['redis://default:r3dis-pw@cache.internal:6379/0', 'redis://***@cache.internal:6379/0'],
    ['postgres://u:p@ss@host/db', 'postgres://***@host/db'],
    ['postgres://brokkr:s3cret@[bad host/db', 'postgres://***@[bad host/db'],
    ['://brokkr:s3cret@db.internal/x', '***'],
    ['https://example.com/path?q=a@b', 'https://example.com/path?q=a@b'],
  ])('masks %s to %s', (value, expected) => {
    expect(maskDsn(value)).toBe(expected);
  });

  it.each([
    'postgres://brokkr:s3cret@db.internal:5432/brokkr',
    'redis://default:r3dis-pw@cache.internal:6379/0',
    'postgres://u:p@ss@host/db',
    'postgres://brokkr:s3cret@[bad host/db',
    '://brokkr:s3cret@db.internal/x',
  ])('strips every credential out of %s', (value) => {
    const masked = maskDsn(value);
    for (const secret of ['s3cret', 'r3dis-pw', 'p@ss', 'brokkr:', 'default:']) {
      expect(masked).not.toContain(secret);
    }
  });
});

describe('maskEmbeddedDsns', () => {
  it.each([
    ['postgres://brokkr:s3cret@db.internal:5432/brokkr', 'postgres://***@db.internal:5432/brokkr'],
    ["SELECT 'postgres://u:p@h/db'", "SELECT 'postgres://***@h/db'"],
    [
      'see https://docs.example.com/x or email ops@example.com',
      'see https://docs.example.com/x or email ops@example.com',
    ],
    ['https://example.com/path?q=a@b', 'https://example.com/path?q=a@b'],
    ['postgres://u:p@h/db and redis://a:b@c/0', 'postgres://***@h/db and redis://***@c/0'],
    ['postgres://u:p@ss@host/db', 'postgres://***@host/db'],
    ['://brokkr:s3cret@db.internal/x', '://***@db.internal/x'],
    ['postgres://u:p@h,redis://a:b@c', 'postgres://***@h,redis://***@c'],
    ['select 1', 'select 1'],
    ['user@example.com', 'user@example.com'],
    ['https://assets.example.com/os-layers', 'https://assets.example.com/os-layers'],
  ])('rewrites %s to %s', (value, expected) => {
    expect(maskEmbeddedDsns(value)).toBe(expected);
  });

  it('is idempotent and stateless across repeated calls', () => {
    const once = maskEmbeddedDsns('postgres://u:p@h/db and redis://a:b@c/0');
    expect(maskEmbeddedDsns(once)).toBe(once);
    expect(maskEmbeddedDsns('postgres://u:p@h/db')).toBe('postgres://***@h/db');
    expect(maskEmbeddedDsns('postgres://u:p@h/db')).toBe('postgres://***@h/db');
  });
});

describe('redactPayload', () => {
  it('replaces a denylisted value with the marker instead of dropping the key', () => {
    expect(redactPayload({ password: 'x' })).toEqual({ password: '***' });
  });

  it('catches the authorization and passphrase widening', () => {
    expect(redactPayload({ authorization: 'Bearer x', passphrase: 'x' })).toEqual({
      authorization: '***',
      passphrase: '***',
    });
  });

  it('leaves sql verbatim', () => {
    expect(redactPayload({ sql: 'select 1' })).toEqual({ sql: 'select 1' });
    expect(redactPayload({ sql: 'SELECT id, name FROM device WHERE zone_id = $1' })).toEqual({
      sql: 'SELECT id, name FROM device WHERE zone_id = $1',
    });
  });

  it('masks a dsn literal embedded in sql without collapsing the query', () => {
    expect(redactPayload({ sql: "SELECT 'postgres://u:p3w@h/db'" })).toEqual({
      sql: "SELECT 'postgres://***@h/db'",
    });
  });

  it('leaves a destructive statement legible so an audit row still names it', () => {
    expect(redactPayload({ sql: 'DROP TABLE device' })).toEqual({ sql: 'DROP TABLE device' });
  });

  it('masks a credential-bearing dsn under a non-denylisted key', () => {
    const out = redactPayload({ hub: { DATABASE_URL: 'postgres://brokkr:s3cret@db.internal:5432/brokkr' } });
    expect(JSON.stringify(out)).not.toContain('s3cret');
    expect(out).toEqual({ hub: { DATABASE_URL: 'postgres://***@db.internal:5432/brokkr' } });
  });

  it('masks a redis dsn under a non-denylisted key', () => {
    const out = redactPayload({ spoke: { REDIS_URL: 'redis://default:r3dis-pw@cache.internal:6379/0' } });
    expect(JSON.stringify(out)).not.toContain('r3dis-pw');
    expect(out).toEqual({ spoke: { REDIS_URL: 'redis://***@cache.internal:6379/0' } });
  });

  it('masks a dsn nested deeper under arrays and objects', () => {
    const out = redactPayload({ a: [{ b: { urls: ['amqp://svc:p4ss@mq.internal:5672/vh'] } }] });
    expect(JSON.stringify(out)).not.toContain('p4ss');
    expect(out).toEqual({ a: [{ b: { urls: ['amqp://***@mq.internal:5672/vh'] } }] });
  });

  it('masks a bare dsn string leaf', () => {
    expect(redactPayload('postgres://brokkr:s3cret@db.internal/brokkr')).toBe('postgres://***@db.internal/brokkr');
  });

  it('masks a scheme-less dsn in place rather than collapsing it', () => {
    const out = redactPayload({ dsn: '://brokkr:s3cret@db.internal/x' });
    expect(JSON.stringify(out)).not.toContain('s3cret');
    expect(out).toEqual({ dsn: '://***@db.internal/x' });
  });

  it('leaves prose carrying a url and a bare email byte-identical', () => {
    const note = 'see https://docs.example.com/x or email ops@example.com';
    expect(redactPayload({ note })).toEqual({ note });
  });

  it('leaves an @ inside a query string alone', () => {
    const url = 'https://example.com/path?q=a@b';
    expect(redactPayload({ url })).toEqual({ url });
  });

  it('leaves a netplan document containing a plain url byte-identical', () => {
    const netplan = [
      'network:',
      '  version: 2',
      '  ethernets:',
      '    eno1:',
      '      addresses: [10.0.0.5/24]',
      '      nameservers:',
      '        search: [corp.example.com]',
      '# mirror: https://archive.ubuntu.com/ubuntu',
      '# owner: ops@example.com',
    ].join('\n');
    expect(redactPayload({ netplan })).toEqual({ netplan });
  });

  it('masks every dsn when one string carries two', () => {
    const out = redactPayload({ conn: 'postgres://u:p@h/db and redis://a:b@c/0' });
    expect(JSON.stringify(out)).not.toContain('"p@');
    expect(out).toEqual({ conn: 'postgres://***@h/db and redis://***@c/0' });
  });

  it('strips a password containing an @ without eating the host', () => {
    expect(redactPayload({ conn: 'postgres://u:p@ss@host/db' })).toEqual({ conn: 'postgres://***@host/db' });
  });

  it('never turns a string value into the flat marker', () => {
    const values = [
      'postgres://brokkr:s3cret@db.internal:5432/brokkr',
      "SELECT 'postgres://u:p3w@h/db'",
      '://brokkr:s3cret@db.internal/x',
      'see https://docs.example.com/x or email ops@example.com',
      'https://example.com/path?q=a@b',
      'postgres://u:p@ss@host/db',
      '://@',
      '://',
      '@',
      'plain',
    ];
    for (const value of values) {
      expect(redactPayload({ note: value })).not.toEqual({ note: '***' });
    }
  });

  it('collapses cloud-init user-data to the flat marker', () => {
    expect(redactPayload({ cloudInit: '#cloud-config\nchpasswd:\n  list: |\n    root:hunter2\n' })).toEqual({
      cloudInit: '***',
    });
  });

  it('leaves a plain non-dsn string under a non-denylisted key untouched', () => {
    expect(
      redactPayload({
        name: 'e2e-suite-ci',
        note: 'user@example.com',
        base: 'https://assets.example.com/os-layers',
        path: '/home/op/hub',
        count: 3,
      }),
    ).toEqual({
      name: 'e2e-suite-ci',
      note: 'user@example.com',
      base: 'https://assets.example.com/os-layers',
      path: '/home/op/hub',
      count: 3,
    });
  });

  it('keeps key-based redaction ahead of value masking', () => {
    expect(redactPayload({ password: 'postgres://brokkr:s3cret@db.internal/brokkr' })).toEqual({ password: '***' });
    expect(redactPayload({ pubkeys: ['postgres://a:b@h/d', 'postgres://c:d@h/d'] })).toEqual({
      pubkeys: '<redacted: 2 items>',
    });
  });

  it('recurses nested objects', () => {
    expect(redactPayload({ outer: { inner: { token: 'abc', keep: 'yes' } } })).toEqual({
      outer: { inner: { token: '***', keep: 'yes' } },
    });
  });

  it('recurses arrays of objects', () => {
    expect(redactPayload({ rows: [{ api_key: 'a' }, { name: 'b' }] })).toEqual({
      rows: [{ api_key: '***' }, { name: 'b' }],
    });
  });

  it('redacts a denylisted key nested under arrays and objects', () => {
    expect(redactPayload({ a: [{ b: { c: [{ pg_password: 'deep' }] } }] })).toEqual({
      a: [{ b: { c: [{ pg_password: '***' }] } }],
    });
  });

  it('redacts a denylisted key regardless of the value type', () => {
    expect(redactPayload({ secret: { nested: 'still hidden' }, token: 42, credential: null })).toEqual({
      secret: '***',
      token: '***',
      credential: '***',
    });
  });

  it('preserves the item count of a denylisted array', () => {
    expect(redactPayload({ pubkeys: ['ssh-ed25519 AAAA', 'ssh-rsa BBBB'] })).toEqual({
      pubkeys: '<redacted: 2 items>',
    });
    expect(redactPayload({ private: [] })).toEqual({ private: '<redacted: 0 items>' });
  });

  it('still collapses a denylisted non-array value to the flat marker', () => {
    expect(redactPayload({ user_data: '#cloud-config' })).toEqual({ user_data: '***' });
  });

  it('recurses a non-denylisted array instead of marking it', () => {
    expect(redactPayload({ nodes: [{ name: 'a' }, { bmc_pass: 'x' }] })).toEqual({
      nodes: [{ name: 'a' }, { bmc_pass: '***' }],
    });
  });

  it('passes non-object leaves through unchanged', () => {
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeUndefined();
    expect(redactPayload(42)).toBe(42);
    expect(redactPayload('plain')).toBe('plain');
    expect(redactPayload(false)).toBe(false);
    expect(redactPayload(['a', 1])).toEqual(['a', 1]);
  });

  it('does not hang on a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'a', token: 't' };
    cyclic.self = cyclic;
    expect(redactPayload(cyclic)).toEqual({ name: 'a', token: '***', self: '***' });
  });

  it('does not hang on a cyclic array', () => {
    const items: unknown[] = ['a'];
    items.push(items);
    expect(redactPayload(items)).toEqual(['a', '***']);
  });

  it('expands a shared non-cyclic reference twice', () => {
    const shared = { name: 'n' };
    expect(redactPayload({ first: shared, second: shared })).toEqual({
      first: { name: 'n' },
      second: { name: 'n' },
    });
  });
});

describe('redactPayloadCapped', () => {
  it('redacts secret-keyed values at any depth and reports a secret array as a count', () => {
    expect(
      redactPayloadCapped({
        saga_name: 'provision',
        lifecycle_data: {
          os: 'ubuntu-24.04',
          user_data: '#cloud-config',
          pubkeys: ['ssh-ed25519 AAAA', 'ssh-ed25519 BBBB'],
          bmc: { username: 'admin', bmc_pass: 'hunter2' },
        },
      }),
    ).toEqual({
      value: {
        saga_name: 'provision',
        lifecycle_data: {
          os: 'ubuntu-24.04',
          user_data: '***',
          pubkeys: '<redacted: 2 items>',
          bmc: { username: 'admin', bmc_pass: '***' },
        },
      },
      truncated: false,
    });
  });

  it.each([
    ['user_data', '#cloud-config'],
    ['userData', '#cloud-config'],
    ['cloud_init', '#cloud-config'],
    ['cloudInit', '#cloud-config'],
    ['bmc_pass', 'hunter2'],
    ['bmcPass', 'hunter2'],
    ['password_hash', '$6$notarealhash'],
    ['server_token', 'tok-secret-value'],
    ['authorized_keys', 'ssh-ed25519 AAAA'],
  ])('redacts the denylisted payload key %s', (key, secret) => {
    const { value, truncated } = redactPayloadCapped({ [key]: secret });
    expect(value).toEqual({ [key]: '***' });
    expect(JSON.stringify(value)).not.toContain(secret);
    expect(truncated).toBe(false);
  });

  it('masks a dsn credential riding in a value under an innocuous key', () => {
    const { value, truncated } = redactPayloadCapped({
      hub: { DATABASE_URL: 'postgres://brokkr:s3cret@db.internal:5432/brokkr' },
    });
    expect(JSON.stringify(value)).not.toContain('s3cret');
    expect(value).toEqual({ hub: { DATABASE_URL: 'postgres://***@db.internal:5432/brokkr' } });
    expect(truncated).toBe(false);
  });

  it('masks a dsn before the budget cut so a cut inside the userinfo leaks nothing', () => {
    const { value, truncated } = redactPayloadCapped({ dsn: 'postgres://brokkr:s3cret@db.internal:5432/brokkr' }, 30);
    const rendered = JSON.stringify(value);
    expect(truncated).toBe(true);
    expect(rendered).toContain('***@');
    expect(rendered).not.toContain('brokkr:');
    expect(rendered).not.toContain('s3c');
  });

  it('drops the remaining record keys once the budget is spent', () => {
    const { value, truncated } = redactPayloadCapped({ a: 'x'.repeat(8), b: 'y'.repeat(8), c: 'z'.repeat(8) }, 30);
    expect(value).toEqual({ a: 'x'.repeat(8), b: 'y'.repeat(8) });
    expect(truncated).toBe(true);
  });

  it('bounds a key longer than the budget and reports it as truncated', () => {
    const { value, truncated } = redactPayloadCapped({ ['k'.repeat(50_000)]: 1 });
    expect(value).toEqual({});
    expect(truncated).toBe(true);
    expect(JSON.stringify(value).length).toBeLessThan(PAYLOAD_BYTE_CAP);
  });

  it('drops the remaining array items once the budget is spent', () => {
    const { value, truncated } = redactPayloadCapped(['aa', 'bb', 'cc'], 10);
    expect(value).toEqual(['aa', 'bb']);
    expect(truncated).toBe(true);
  });

  it('clips a single oversized string with the truncation suffix', () => {
    const { value, truncated } = redactPayloadCapped({ stdout: 'x'.repeat(100) }, 40);
    expect(value).toEqual({ stdout: `${'x'.repeat(28)}…[truncated]` });
    expect(truncated).toBe(true);
  });

  it('collapses to the bare suffix when nothing of a string fits the budget', () => {
    const { value, truncated } = redactPayloadCapped({ stdout: 'x'.repeat(100) }, 12);
    expect(value).toEqual({ stdout: '…[truncated]' });
    expect(truncated).toBe(true);
  });

  it('flags a collector-sized payload the default cap cuts short', () => {
    const big = { fields: Array.from({ length: 4_000 }, (_, i) => ({ name: `nic${i}`, mac: 'aa:bb:cc:dd:ee:ff' })) };
    const { value, truncated } = redactPayloadCapped(big);
    expect(truncated).toBe(true);
    expect(JSON.stringify(value).length).toBeLessThan(PAYLOAD_BYTE_CAP * 2);
  });

  it('honours an explicit cap over the default', () => {
    expect(redactPayloadCapped({ a: 'x'.repeat(64) }, 16).truncated).toBe(true);
    expect(redactPayloadCapped({ a: 'x'.repeat(4) }, 4_096).truncated).toBe(false);
  });

  it('does not hang on a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'a', token: 't' };
    cyclic.self = cyclic;
    expect(redactPayloadCapped(cyclic)).toEqual({ value: { name: 'a', token: '***', self: '***' }, truncated: false });
  });

  it('passes non-object leaves through unchanged', () => {
    expect(redactPayloadCapped(null).value).toBeNull();
    expect(redactPayloadCapped(7).value).toBe(7);
    expect(redactPayloadCapped('plain').value).toBe('plain');
  });
});

describe('serializeAuditParams', () => {
  it('returns null for undefined and for an empty object', () => {
    expect(serializeAuditParams(undefined)).toBeNull();
    expect(serializeAuditParams({})).toBeNull();
  });

  it('serializes the redacted payload', () => {
    expect(serializeAuditParams({ sql: 'select 1', password: 'x' })).toBe('{"sql":"select 1","password":"***"}');
  });

  it('keeps an under-cap payload byte-identical to JSON.stringify', () => {
    const payload = { note: 'y'.repeat(1000) };
    expect(serializeAuditParams(payload)).toBe(JSON.stringify(payload));
  });

  it('truncates an over-cap payload to the 8 KiB cap and stays parseable', () => {
    const out = serializeAuditParams({ note: 'y'.repeat(20_000) });
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(out)).toMatch(/\[truncated\]$/);
  });

  it('keeps the cap on a multi-byte over-cap payload', () => {
    const out = serializeAuditParams({ note: '✓'.repeat(20_000) });
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(out)).toMatch(/\[truncated\]$/);
  });

  it('never persists the dsn credential from a stack-config body', () => {
    const out = serializeAuditParams({
      hub: { DATABASE_URL: 'postgres://brokkr:s3cret@db.internal:5432/brokkr' },
      spoke: { REDIS_URL: 'redis://default:r3dis-pw@cache.internal:6379/0' },
    });
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('r3dis-pw');
    expect(out).toBe(
      '{"hub":{"DATABASE_URL":"postgres://***@db.internal:5432/brokkr"},"spoke":{"REDIS_URL":"redis://***@cache.internal:6379/0"}}',
    );
  });

  it('never persists cloud-init user-data from a test-run body', () => {
    const out = serializeAuditParams({
      scenario: 'cloud-init',
      cloudInit: '#cloud-config\nssh_keys:\n  rsa_private: |\n    -----BEGIN OPENSSH PRIVATE KEY-----\n',
    });
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out).not.toContain('PRIVATE KEY');
    expect(out).toBe('{"scenario":"cloud-init","cloudInit":"***"}');
  });

  it('redacts before truncating', () => {
    const out = serializeAuditParams({ password: 'hunter2', note: 'y'.repeat(20_000) });
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out).not.toContain('hunter2');
  });
});

describe('a path-keyed config write body', () => {
  it('masks a secret knob whose path reads as ordinary', () => {
    const body = { entries: { 'zoneCrypto.bridgeAtRestKey': 'sentinel-value-not-a-key' } };

    expect(redactPayload(body)).toEqual({ entries: { 'zoneCrypto.bridgeAtRestKey': '***' } });
    expect(serializeAuditParams(body)).not.toContain('sentinel-value-not-a-key');
  });

  it('masks an ordinary knob too, so a knob declared secret later is not a coin flip', () => {
    expect(redactPayload({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } })).toEqual({
      entries: { 'stackDefaults.hub.LOG_LEVEL': '***' },
    });
  });

  it('keeps the paths, which is what an auditor needs', () => {
    const out = redactPayload({ entries: { 'a.b': 'x', 'c.d': 'y' } }) as Record<string, unknown>;

    expect(Object.keys(out.entries as Record<string, unknown>)).toEqual(['a.b', 'c.d']);
  });

  it('keeps a null entry visible, since a revert is not a secret', () => {
    expect(redactPayload({ entries: { 'ports.postgres': null } })).toEqual({
      entries: { 'ports.postgres': null },
    });
  });

  it('masks on the capped path too', () => {
    const out = redactPayloadCapped({ entries: { 'zoneCrypto.bridgeAtRestKey': 'secret-bytes' } });

    expect(JSON.stringify(out.value)).not.toContain('secret-bytes');
  });
});
