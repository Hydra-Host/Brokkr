import { describe, expect, it } from 'vitest';

import { isLeafActive, leafPath, SECTIONS } from './app-sidebar';

describe('SECTIONS order', () => {
  it('opens with the section holding the landing page, not with a settings area', () => {
    expect(SECTIONS[0].title).toBe('Environment');
    expect(SECTIONS[0].leaves[0].to).toBe('/');
  });

  it('keeps the reference material last', () => {
    expect(SECTIONS[SECTIONS.length - 1].title).toBe('Reference');
  });

  it('puts what you look at before what you change', () => {
    const at = (title: string) => SECTIONS.findIndex((s) => s.title === title);
    expect(at('Environment')).toBeLessThan(at('Configuration'));
    expect(at('Testing')).toBeLessThan(at('Configuration'));
  });
});

describe('SECTIONS leaves', () => {
  const leaves = SECTIONS.flatMap((s) => s.leaves);

  it('gives no two leaves the same label, which the rail and the breadcrumb both show', () => {
    const labels = leaves.map((l) => l.label);
    expect(labels.length).toBe(new Set(labels).size);
  });

  it('gives no two leaves the same path', () => {
    const paths = leaves.map(leafPath);
    expect(paths.length).toBe(new Set(paths).size);
  });

  it('marks every index route exact, or its marker lights up on each child page', () => {
    for (const leaf of leaves) {
      const children = leaves.filter((l) => leafPath(l).startsWith(`${leafPath(leaf)}/`));
      if (children.length > 0) expect(leaf.exact).toBe(true);
    }
  });

  it('keeps the two config leaves distinguishable from the environment views they mirror', () => {
    const labels = SECTIONS.flatMap((s) => s.leaves).map((l) => l.label);
    expect(labels).toContain('Stack');
    expect(labels).toContain('Stack knobs');
    expect(labels).toContain('Fleet');
    expect(labels).toContain('Fleet nodes');
  });

  it('injects the apps block before exactly one section', () => {
    expect(SECTIONS.filter((s) => s.appsBefore === true)).toHaveLength(1);
  });
});

describe('isLeafActive', () => {
  it('keeps an exact leaf off its own children', () => {
    const config = SECTIONS.flatMap((s) => s.leaves).find((l) => l.to === '/config');
    expect(config && isLeafActive('/config', config)).toBe(true);
    expect(config && isLeafActive('/config/stack', config)).toBe(false);
  });

  it('marks a non-exact leaf active on a nested path', () => {
    const stack = SECTIONS.flatMap((s) => s.leaves).find((l) => l.to === '/config/stack');
    expect(stack && isLeafActive('/config/stack', stack)).toBe(true);
  });
});
