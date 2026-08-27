// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { getWikiEntry } from '@/lib/wiki';

import { DEPLOY_STEPS, OPS_STEPS, ORIENTATION_STEPS, type TourStep } from './tour-steps';

const DECKS: [string, TourStep[]][] = [
  ['orientation', ORIENTATION_STEPS],
  ['deploy', DEPLOY_STEPS],
  ['ops', OPS_STEPS],
];

describe.each(DECKS)('%s steps', (_name, steps) => {
  it('gives every step a title and description', () => {
    steps.forEach((step, i) => {
      expect(step.title.trim(), `step ${i}`).not.toBe('');
      expect(step.description.trim(), `step ${i}`).not.toBe('');
    });
  });

  it('points every wiki-term anchor at a real entry', () => {
    for (const step of steps) {
      for (const [, slug] of step.description.matchAll(/data-wiki="([^"]+)"/g)) {
        expect(getWikiEntry(slug), slug).toBeDefined();
      }
    }
  });

  it('labels every wiki-term anchor with hover text', () => {
    for (const step of steps) {
      for (const [, title, label] of step.description.matchAll(
        /<a class="wiki-term"[^>]*title="([^"]*)"[^>]*>([^<]*)<\/a>/g,
      )) {
        expect(title).not.toBe('');
        expect(label).not.toBe('');
      }
    }
  });
});
