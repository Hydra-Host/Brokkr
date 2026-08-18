import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyze, BANNED, LIMITS, prose } from './prose-lint.mjs';

test('a single em-dash is within the per-page budget', () => {
  const r = analyze('The bridge runs in each zone — one per site.');
  assert.equal(r.emDashes, 1);
  assert.equal(r.errors.length, 0);
});

test('more em-dashes than the max is an error', () => {
  const r = analyze('One — two — three em-dashes here.');
  assert.equal(r.emDashes, 2);
  assert.ok(r.errors.some((e) => e.includes('em-dash')));
});

test('em-dashes inside fenced code blocks are not counted', () => {
  const r = analyze('```\nconst x = a — b — c;\n```\nPlain sentence with no dash.');
  assert.equal(r.emDashes, 0);
  assert.equal(r.errors.length, 0);
});

test('em-dashes inside frontmatter are not counted', () => {
  const r = analyze('---\ntitle: a — b — c — d\n---\nBody prose without a dash.');
  assert.equal(r.emDashes, 0);
  assert.equal(r.errors.length, 0);
});

test('em-dashes inside inline code are not counted', () => {
  const r = analyze('Run `a — b — c` and then continue.');
  assert.equal(r.emDashes, 0);
  assert.equal(r.errors.length, 0);
});

test('banned marketing phrases surface as warnings', () => {
  const r = analyze('This is seamless and robust and powerful.');
  assert.ok(r.warns.some((w) => w.includes('seamless')));
  assert.ok(r.warns.some((w) => w.includes('robust')));
  assert.ok(r.warns.some((w) => w.includes('powerful')));
  assert.equal(r.errors.length, 0);
});

test('contrast reversals over budget are an error', () => {
  const r = analyze('Cheap — not dear, and fast — not slow.');
  assert.ok(r.errors.some((e) => e.includes('reversal')));
});

test('a negative litany is an error', () => {
  const r = analyze('There is no fuss, no muss in this flow.');
  assert.ok(r.errors.some((e) => e.includes('litany')));
});

test('too many list-of-three constructions warn', () => {
  const r = analyze('We ship apples, oranges, and pears. They pick red, green, or blue.');
  assert.ok(r.warns.some((w) => w.includes('list-of-three')));
});

test('prose strips frontmatter, code, tables, and import/export lines', () => {
  const stripped = prose(
    [
      '---',
      'x: 1',
      '---',
      '| a | b |',
      'import X from "y";',
      'export const z = 1;',
      'Keep `code` text.',
      '```',
      'fenced dash —',
      '```',
    ].join('\n'),
  );
  assert.ok(stripped.includes('Keep CODE text.'));
  assert.ok(!stripped.includes('fenced dash'));
  assert.ok(!stripped.includes('import X'));
  assert.ok(!stripped.includes('| a | b |'));
});

test('limits and banned list are exported and non-empty', () => {
  assert.equal(LIMITS.emDashMax, 1);
  assert.ok(Array.isArray(BANNED) && BANNED.length > 0);
});
