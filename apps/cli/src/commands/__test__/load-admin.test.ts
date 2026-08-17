import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('loadAdminCommands', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is a no-op when the admin package is absent', async () => {
    vi.doMock('@hydrahost/admin-cli', () => ({
      registerAdminCommands: () => {
        const err: NodeJS.ErrnoException = new Error(
          "Cannot find package '@hydrahost/admin-cli' imported from /home/user/node_modules/@hydrahost/brokkr-cli/index.js",
        );
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      },
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadAdminCommands } = await import('../../admin/load-admin.js');
    const program = new Command();
    await expect(loadAdminCommands(program)).resolves.toBeUndefined();
    expect(program.commands.find((c) => c.name() === 'admin')).toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('warns instead of silently omitting when a transitive dependency is missing', async () => {
    vi.doMock('@hydrahost/admin-cli', () => ({
      registerAdminCommands: () => {
        const err: NodeJS.ErrnoException = new Error(
          "Cannot find module '@hydrahost/admin-api-client/dist/index.mjs' " +
            'imported from /home/user/node_modules/@hydrahost/admin-cli/dist/index.js',
        );
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      },
    }));
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadAdminCommands } = await import('../../admin/load-admin.js');
    const program = new Command();
    await expect(loadAdminCommands(program)).resolves.toBeUndefined();
    expect(program.commands.find((c) => c.name() === 'admin')).toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('admin commands present but failed to load');
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('registers the admin command when the package is present', async () => {
    vi.doMock('@hydrahost/admin-cli', () => ({
      registerAdminCommands: (p: Command) => {
        p.command('admin');
      },
    }));
    const { loadAdminCommands } = await import('../../admin/load-admin.js');
    const program = new Command();
    await loadAdminCommands(program);
    expect(program.commands.find((c) => c.name() === 'admin')).toBeDefined();
  });

  it('skips loading when BROKKR_NO_ADMIN=1', async () => {
    vi.doMock('@hydrahost/admin-cli', () => ({
      registerAdminCommands: (p: Command) => {
        p.command('admin');
      },
    }));
    const { loadAdminCommands } = await import('../../admin/load-admin.js');
    const program = new Command();
    process.env.BROKKR_NO_ADMIN = '1';
    await loadAdminCommands(program);
    delete process.env.BROKKR_NO_ADMIN;
    expect(program.commands.find((c) => c.name() === 'admin')).toBeUndefined();
  });
});
