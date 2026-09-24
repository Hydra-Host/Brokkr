// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'theme-init.js'), 'utf8');

function runThemeInit() {
  new Function(source)();
}

function resetDom() {
  const doc = document.documentElement;
  for (const attr of ['data-style', 'data-color', 'data-mode', 'data-preset', 'data-theme']) {
    doc.removeAttribute(attr);
  }
  localStorage.clear();
}

afterEach(resetDom);

describe('theme-init.js', () => {
  it('applies built-in defaults when nothing is stored', () => {
    runThemeInit();
    const doc = document.documentElement;
    expect(doc.getAttribute('data-style')).toBe('retro');
    expect(doc.getAttribute('data-color')).toBe('violet');
    expect(doc.getAttribute('data-mode')).toBe('dark');
  });

  it('applies a stored choice', () => {
    localStorage.setItem('brokkr-style', 'modern');
    localStorage.setItem('brokkr-color', 'pink');
    localStorage.setItem('brokkr-mode', 'light');
    runThemeInit();
    const doc = document.documentElement;
    expect(doc.getAttribute('data-style')).toBe('modern');
    expect(doc.getAttribute('data-color')).toBe('pink');
    expect(doc.getAttribute('data-mode')).toBe('light');
  });

  it('ignores unknown stored values', () => {
    localStorage.setItem('brokkr-color', 'teal');
    runThemeInit();
    expect(document.documentElement.getAttribute('data-color')).toBe('violet');
  });

  it('removes the retired data-theme and data-preset attributes', () => {
    const doc = document.documentElement;
    doc.setAttribute('data-theme', 'hydra-dark');
    doc.setAttribute('data-preset', 'hydra');
    localStorage.setItem('brokkr-theme', 'hydra-dark');
    runThemeInit();
    expect(doc.hasAttribute('data-theme')).toBe(false);
    expect(doc.hasAttribute('data-preset')).toBe(false);
    expect(doc.getAttribute('data-style')).toBe('retro');
  });

  it('still migrates legacy theme ids', () => {
    localStorage.setItem('brokkr-theme', 'yellow');
    runThemeInit();
    const doc = document.documentElement;
    expect(doc.getAttribute('data-style')).toBe('retro');
    expect(doc.getAttribute('data-color')).toBe('gold');
    expect(doc.getAttribute('data-mode')).toBe('dark');
  });
});
