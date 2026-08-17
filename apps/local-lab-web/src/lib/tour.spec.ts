// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleTourKeydown, isEditableEventTarget } from './tour';

describe('isEditableEventTarget', () => {
  const dispatchFrom = (el: EventTarget): EventTarget | null => {
    let seen: EventTarget | null = null;
    el.addEventListener('keydown', (ev) => {
      seen = ev.target;
    });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    return seen;
  };

  it.each(['input', 'textarea', 'select'])('treats <%s> as editable', (tag) => {
    const el = document.createElement(tag);
    document.body.appendChild(el);
    expect(isEditableEventTarget(dispatchFrom(el))).toBe(true);
  });

  it('treats a contenteditable element as editable', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'isContentEditable', { value: true });
    document.body.appendChild(el);
    expect(isEditableEventTarget(el)).toBe(true);
  });

  it('does not treat a plain non-editable element as editable', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(isEditableEventTarget(dispatchFrom(el))).toBe(false);
  });

  it('returns false for a null target', () => {
    expect(isEditableEventTarget(null)).toBe(false);
  });
});

describe('tour keydown wiring', () => {
  const actions = {
    endPeek: vi.fn(),
    clearExitHint: vi.fn(),
    pause: vi.fn(),
    advance: vi.fn(),
    back: vi.fn(),
  };
  const onKey = (ev: KeyboardEvent) => handleTourKeydown(ev, actions);

  beforeEach(() => {
    vi.clearAllMocks();
    document.addEventListener('keydown', onKey, true);
  });

  afterEach(() => {
    document.removeEventListener('keydown', onKey, true);
    document.body.replaceChildren();
    document.body.classList.remove('tour-peek');
  });

  const dispatch = (from: EventTarget, key: string): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    from.dispatchEvent(ev);
    return ev;
  };

  const mount = (tag: string): HTMLElement => {
    const el = document.createElement(tag);
    document.body.appendChild(el);
    return el;
  };

  it.each([' ', 'ArrowRight', 'ArrowLeft', 'Escape'])('does not hijack %s typed into a field', (key) => {
    const ev = dispatch(mount('input'), key);
    expect(ev.defaultPrevented).toBe(false);
    expect(actions.advance).not.toHaveBeenCalled();
    expect(actions.back).not.toHaveBeenCalled();
    expect(actions.pause).not.toHaveBeenCalled();
  });

  it('advances and preventDefaults Space from a non-editable target', () => {
    const ev = dispatch(mount('div'), ' ');
    expect(ev.defaultPrevented).toBe(true);
    expect(actions.advance).toHaveBeenCalledTimes(1);
  });

  it('goes back on ArrowLeft from a non-editable target', () => {
    const ev = dispatch(mount('div'), 'ArrowLeft');
    expect(ev.defaultPrevented).toBe(true);
    expect(actions.back).toHaveBeenCalledTimes(1);
  });

  it('pauses on Escape from a non-editable target', () => {
    const ev = dispatch(mount('div'), 'Escape');
    expect(ev.defaultPrevented).toBe(true);
    expect(actions.pause).toHaveBeenCalledTimes(1);
  });

  it('while minimized, only restores the slide (never advances)', () => {
    document.body.classList.add('tour-peek');
    const ev = dispatch(mount('div'), ' ');
    expect(ev.defaultPrevented).toBe(true);
    expect(actions.endPeek).toHaveBeenCalledTimes(1);
    expect(actions.advance).not.toHaveBeenCalled();
  });
});
