import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repoRootOfCwd } from './stack-registry.js';
import {
  describeCandidates,
  describeCheckout,
  describeTarget,
  selectStackTarget,
  slotTargetFromEnv,
} from './target.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const repoRoot = repoRootOfCwd() ?? '/repo';
const sibling = join(repoRoot, '.worktrees', 'session-integration');
const foreign = '/checkouts/another-clone';

function fixtureDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lab-mcp-target-'));
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

const twoStacks = () =>
  fixtureDir({
    'stack-0.json': entry(0, sibling, 3002),
    'stack-2.json': entry(2, foreign, 21002),
  });

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a refusal');
}

describe('describeCheckout', () => {
  it('renders a checkout of this repository relative to its root', () => {
    expect(describeCheckout(sibling, repoRoot)).toBe('.worktrees/session-integration');
    expect(describeCheckout(repoRoot, repoRoot)).toBe('.');
  });

  it('renders an unrelated clone as its full path', () => {
    expect(describeCheckout(foreign, repoRoot)).toBe(foreign);
    expect(describeCheckout(sibling, null)).toBe(sibling);
  });
});

describe('describeTarget', () => {
  it('names the slot and the checkout', () => {
    const target = selectStackTarget({ slot: 0 }, twoStacks());
    expect(describeTarget(target)).toBe('[lab: slot 0 · .worktrees/session-integration]');
  });

  it('falls back to the base url when no slot is known', () => {
    expect(
      describeTarget({
        baseUrl: 'http://pinned:9',
        slot: null,
        checkout: null,
        sameRepo: false,
        source: 'env-url',
        own: false,
      }),
    ).toBe('[lab: http://pinned:9]');
  });
});

describe('describeCandidates', () => {
  it('reports slot, location, liveness, repository relation and lab port', () => {
    const listing = describeCandidates(
      [
        { slot: 0, checkout: sibling, labPort: 3002, live: true, state: 'up', sameRepo: true },
        { slot: 2, checkout: foreign, labPort: null, live: false, state: 'down', sameRepo: false },
      ],
      repoRoot,
    );
    expect(listing).toContain('slot 0  .worktrees/session-integration  live, same repo, lab 3002');
    expect(listing).toContain(`slot 2  ${foreign}  down, other clone, no lab port yet`);
  });
});

describe('selectStackTarget by slot', () => {
  it('targets the recorded lab port of that slot', () => {
    expect(selectStackTarget({ slot: 0 }, twoStacks())).toEqual({
      baseUrl: 'http://127.0.0.1:3002',
      slot: 0,
      checkout: sibling,
      sameRepo: true,
      source: 'tool',
      own: false,
    });
  });

  it('reaches a checkout of another clone, because a slot number is deliberate', () => {
    const target = selectStackTarget({ slot: 2 }, twoStacks());
    expect(target.checkout).toBe(foreign);
    expect(target.sameRepo).toBe(false);
  });

  it('refuses an unclaimed slot and lists what is registered', () => {
    const message = refusal(() => selectStackTarget({ slot: 41 }, twoStacks()));
    expect(message).toContain('no stack is registered on slot 41');
    expect(message).toContain('slot 0  .worktrees/session-integration');
    expect(message).toContain('slot 2');
  });

  it('refuses a slot whose entry records no lab port yet', () => {
    const dir = fixtureDir({ 'stack-1.json': entry(1, sibling, null) });
    const message = refusal(() => selectStackTarget({ slot: 1 }, dir));
    expect(message).toContain('records no lab port yet');
    expect(message).toContain('task up');
  });

  it('refuses when nothing is registered at all', () => {
    const message = refusal(() => selectStackTarget({ slot: 0 }, fixtureDir({})));
    expect(message).toContain('no stacks are registered on this host');
  });
});

describe('selectStackTarget by checkout name', () => {
  it('matches a worktree of this repository by substring', () => {
    expect(selectStackTarget({ checkout: 'session-integration' }, twoStacks()).slot).toBe(0);
  });

  it('matches the exact directory name too', () => {
    const dir = fixtureDir({ 'stack-4.json': entry(4, join(repoRoot, '.worktrees', 'slot-core'), 22002) });
    expect(selectStackTarget({ checkout: 'slot-core' }, dir).slot).toBe(4);
  });

  it('never reaches another clone by name, and says how to reach one', () => {
    const message = refusal(() => selectStackTarget({ checkout: 'another-clone' }, twoStacks()));
    expect(message).toContain("no checkout of this repository matches 'another-clone'");
    expect(message).toContain('slot number only');
  });

  it('refuses a name matching more than one checkout', () => {
    const dir = fixtureDir({
      'stack-0.json': entry(0, join(repoRoot, '.worktrees', 'lab-one'), 3002),
      'stack-1.json': entry(1, join(repoRoot, '.worktrees', 'lab-two'), 20502),
    });
    const message = refusal(() => selectStackTarget({ checkout: 'lab-' }, dir));
    expect(message).toContain("'lab-' matches more than one checkout");
    expect(message).toContain('lab-one');
    expect(message).toContain('lab-two');
  });

  it('refuses a name that matches nothing', () => {
    const message = refusal(() => selectStackTarget({ checkout: 'no-such-worktree' }, twoStacks()));
    expect(message).toContain('no checkout of this repository matches');
  });
});

describe('selectStackTarget arguments', () => {
  it('refuses both a slot and a checkout together', () => {
    expect(refusal(() => selectStackTarget({ slot: 0, checkout: 'x' }, twoStacks()))).toBe(
      'pass slot or checkout, not both',
    );
  });

  it('refuses neither', () => {
    expect(refusal(() => selectStackTarget({}, twoStacks()))).toBe('pass slot or checkout');
  });
});

describe('slotTargetFromEnv', () => {
  it('returns null when LAB_MCP_SLOT is unset or blank', () => {
    vi.stubEnv('LAB_MCP_SLOT', undefined);
    expect(slotTargetFromEnv(twoStacks())).toBeNull();
    vi.stubEnv('LAB_MCP_SLOT', '  ');
    expect(slotTargetFromEnv(twoStacks())).toBeNull();
  });

  it('resolves the named slot and records the environment as the source', () => {
    vi.stubEnv('LAB_MCP_SLOT', '2');
    const target = slotTargetFromEnv(twoStacks());
    expect(target?.baseUrl).toBe('http://127.0.0.1:21002');
    expect(target?.source).toBe('env-slot');
    expect(target?.own).toBe(false);
  });

  it('refuses a value that is not a slot number', () => {
    vi.stubEnv('LAB_MCP_SLOT', '3002x');
    expect(refusal(() => slotTargetFromEnv(twoStacks()))).toContain('LAB_MCP_SLOT is not a slot number: 3002x');
  });
});
