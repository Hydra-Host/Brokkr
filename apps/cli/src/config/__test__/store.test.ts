import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function loadStoreWithHome(home: string) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.BROKKR_DEFAULT_ENV;
  vi.resetModules();
  return import('../store.js');
}

describe('saveSession', () => {
  let home: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'brokkr-store-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it('writes the session file with mode 0o600 (owner read/write only)', async () => {
    const store = await loadStoreWithHome(home);
    store.saveSession({ cookie: 'session=abc', email: 'u@x.com', userId: 'user_1' });

    const sessionFile = join(home, '.config', 'brokkr', 'session-local.json');
    const mode = statSync(sessionFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('persists the credential fields and stamps environment + storedAt', async () => {
    const store = await loadStoreWithHome(home);
    store.saveSession({ cookie: 'session=abc', apiKey: 'k_123', email: 'u@x.com', userId: 'user_1' });

    const saved = store.getSession();
    expect(saved).toMatchObject({
      cookie: 'session=abc',
      apiKey: 'k_123',
      email: 'u@x.com',
      userId: 'user_1',
      environment: 'local',
    });
    expect(typeof saved?.storedAt).toBe('string');
  });
});
