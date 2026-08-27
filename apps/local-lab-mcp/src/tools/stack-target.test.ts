import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import labUtilsPkg from '../lab-utils.js';
import { repoRootOfCwd } from '../stack-registry.js';
import { createTestServer, stubApi } from '../testkit.js';

const { isRecord } = labUtilsPkg;

afterEach(() => {
  vi.unstubAllEnvs();
});

const repoRoot = repoRootOfCwd() ?? '/repo';
const sibling = join(repoRoot, '.worktrees', 'session-integration');

function fixtureDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lab-mcp-use-stack-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(body));
  }
  return dir;
}

function entry(slot: number, checkout: string, labPort: number | null) {
  return {
    slot,
    checkout,
    pcSock: `/tmp/pc-${slot}.sock`,
    pcDaemonPid: process.pid,
    state: 'up',
    ports: labPort === null ? {} : { lab: labPort },
  };
}

const registry = () =>
  fixtureDir({
    'stack-0.json': entry(0, sibling, 3002),
    'stack-2.json': entry(2, '/checkouts/another-clone', 21002),
  });

function statusStub() {
  return stubApi({
    'GET /api/status': { status: 200, body: { version: '1.2.3' } },
    'GET /api/stacks': { status: 200, body: { stacks: [], selfSlot: 0 } },
  });
}

function contentOf(result: unknown): Array<{ text?: string }> {
  const content = isRecord(result) ? result.content : undefined;
  return Array.isArray(content) ? content : [];
}

function payload(result: unknown): unknown {
  const content = contentOf(result);
  return JSON.parse(String(content[content.length - 1]?.text));
}

function firstText(result: unknown): string {
  return String(contentOf(result)[0]?.text);
}

describe('lab_use_stack', () => {
  it('is registered without the destructive flag', async () => {
    const { client } = await createTestServer(stubApi({}));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('lab_use_stack');
  });

  it('lists the host stacks when called with no argument', async () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const { client } = await createTestServer(stubApi({}), { registryDir: registry() });
    const result = await client.callTool({ name: 'lab_use_stack', arguments: {} });
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toEqual({
      targeted: null,
      stacks: [
        {
          slot: 0,
          checkout: sibling,
          where: '.worktrees/session-integration',
          labPort: 3002,
          live: true,
          state: 'up',
          sameRepo: true,
        },
        {
          slot: 2,
          checkout: '/checkouts/another-clone',
          where: '/checkouts/another-clone',
          labPort: 21002,
          live: true,
          state: 'up',
          sameRepo: false,
        },
      ],
    });
  });

  it('lists the host stacks even though no other stack read can resolve yet', async () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const { client } = await createTestServer(statusStub(), { registryDir: registry() });
    const refused = await client.callTool({ name: 'lab_get_status', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(firstText(refused)).toContain('owns no dev-stack slot');
    const listing = await client.callTool({ name: 'lab_use_stack', arguments: {} });
    expect(listing.isError).toBeUndefined();
  });

  it('targets a slot and makes every other tool reach it', async () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const { client, ctx } = await createTestServer(statusStub(), { registryDir: registry() });
    const targeted = await client.callTool({ name: 'lab_use_stack', arguments: { slot: 0 } });
    expect(payload(targeted)).toEqual({
      targeted: {
        slot: 0,
        checkout: sibling,
        where: '.worktrees/session-integration',
        baseUrl: 'http://127.0.0.1:3002',
        sameRepo: true,
      },
    });
    expect(ctx.baseUrl).toBe('http://127.0.0.1:3002');
    const status = await client.callTool({ name: 'lab_get_status', arguments: {} });
    expect(status.isError).toBeUndefined();
    expect(payload(status)).toMatchObject({
      version: '1.2.3',
      selfSlot: 0,
      labTarget: { slot: 0, checkout: sibling, source: 'tool', own: false },
    });
  });

  it('targets a worktree of this repository by name', async () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const { client } = await createTestServer(stubApi({}), { registryDir: registry() });
    const result = await client.callTool({
      name: 'lab_use_stack',
      arguments: { checkout: 'session-integration' },
    });
    expect(payload(result)).toMatchObject({ targeted: { slot: 0 } });
  });

  it('refuses a checkout of another clone by name', async () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const { client } = await createTestServer(stubApi({}), { registryDir: registry() });
    const result = await client.callTool({ name: 'lab_use_stack', arguments: { checkout: 'another-clone' } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('slot number only');
  });

  it('refuses an unclaimed slot', async () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const { client } = await createTestServer(stubApi({}), { registryDir: registry() });
    const result = await client.callTool({ name: 'lab_use_stack', arguments: { slot: 41 } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('no stack is registered on slot 41');
  });

  it('refuses a slot outside the registry range before it reads anything', async () => {
    const { client } = await createTestServer(stubApi({}), { registryDir: registry() });
    const result = await client.callTool({ name: 'lab_use_stack', arguments: { slot: 47 } });
    expect(result.isError).toBe(true);
  });

  it('refuses a slot whose stack is still coming up', async () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const dir = fixtureDir({ 'stack-1.json': entry(1, sibling, null) });
    const { client } = await createTestServer(stubApi({}), { registryDir: dir });
    const result = await client.callTool({ name: 'lab_use_stack', arguments: { slot: 1 } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('records no lab port yet');
  });
});

describe('target notice', () => {
  it('prefixes every result once a stack this checkout does not own is targeted', async () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const { client } = await createTestServer(statusStub(), { registryDir: registry() });
    await client.callTool({ name: 'lab_use_stack', arguments: { slot: 0 } });
    const status = await client.callTool({ name: 'lab_get_status', arguments: {} });
    expect(firstText(status)).toBe('[lab: slot 0 · .worktrees/session-integration]');
    expect(contentOf(status)).toHaveLength(2);
  });

  it('prefixes an error result too, so a failure never hides which stack answered', async () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const { client } = await createTestServer(
      stubApi({ 'GET /api/status': { status: 500, body: { error: 'boom' } } }),
      { registryDir: registry() },
    );
    await client.callTool({ name: 'lab_use_stack', arguments: { slot: 0 } });
    const status = await client.callTool({ name: 'lab_get_status', arguments: {} });
    expect(status.isError).toBe(true);
    expect(firstText(status)).toBe('[lab: slot 0 · .worktrees/session-integration]');
    expect(String(contentOf(status)[1]?.text)).toContain('getStatus: boom');
  });

  it('adds no prefix while the stack is this checkout own', async () => {
    const { client } = await createTestServer(statusStub());
    const status = await client.callTool({ name: 'lab_get_status', arguments: {} });
    expect(contentOf(status)).toHaveLength(1);
  });

  it('adds no prefix to the refusal itself', async () => {
    vi.stubEnv('LAB_MCP_URL', undefined);
    const { client } = await createTestServer(statusStub(), { registryDir: registry() });
    const status = await client.callTool({ name: 'lab_get_status', arguments: {} });
    expect(status.isError).toBe(true);
    expect(contentOf(status)).toHaveLength(1);
  });
});
