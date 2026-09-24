import { act, cleanup, render } from '@testing-library/react';
import { createElement, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consoleFillHeight, useFillScrollParent } from '../use-fill-scroll-parent';

const COLUMN = { parentTop: 0, parentClientHeight: 800, parentScrollTop: 0, parentPaddingBottom: 56 };

describe('consoleFillHeight', () => {
  it.each([
    {
      name: 'leaves zero column overflow with 56px of bottom padding and 17px of card chrome below',
      metrics: { ...COLUMN, wrapperTop: 300, wrapperBottom: 812, contentBottom: 829 },
      expected: 427,
    },
    {
      name: 'is independent of the scroll position',
      metrics: { ...COLUMN, parentScrollTop: 200, wrapperTop: 100, wrapperBottom: 612, contentBottom: 629 },
      expected: 427,
    },
    {
      name: 'accounts for a scroll parent offset from the viewport',
      metrics: { ...COLUMN, parentTop: 64, wrapperTop: 364, wrapperBottom: 876, contentBottom: 893 },
      expected: 427,
    },
    {
      name: 'keeps the current height when the column already fits',
      metrics: { ...COLUMN, wrapperTop: 300, wrapperBottom: 600, contentBottom: 744 },
      expected: 300,
    },
    {
      name: 'grows the wrapper when the column has slack',
      metrics: { ...COLUMN, wrapperTop: 300, wrapperBottom: 600, contentBottom: 644 },
      expected: 400,
    },
    {
      name: 'grows a short page from its 32rem floor into the free space of a 1980px viewport',
      metrics: {
        parentTop: 90,
        parentClientHeight: 1890,
        parentScrollTop: 0,
        parentPaddingBottom: 56,
        wrapperTop: 479,
        wrapperBottom: 991,
        contentBottom: 1008,
      },
      expected: 1428,
    },
    {
      name: 'is non-negative when the parent is shorter than the wrapper',
      metrics: { ...COLUMN, parentClientHeight: 200, wrapperTop: 150, wrapperBottom: 650, contentBottom: 667 },
      expected: 0,
    },
  ])('$name', ({ metrics, expected }) => {
    expect(consoleFillHeight(metrics)).toBe(expected);
  });

  it('yields the height that makes an overflowing column exactly fit', () => {
    const metrics = { ...COLUMN, wrapperTop: 300, wrapperBottom: 812, contentBottom: 829 };
    const height = consoleFillHeight(metrics);
    const currentHeight = metrics.wrapperBottom - metrics.wrapperTop;
    const contentHeight =
      metrics.contentBottom + metrics.parentPaddingBottom - metrics.parentTop + metrics.parentScrollTop;
    expect(contentHeight - currentHeight + height).toBe(metrics.parentClientHeight);
  });
});

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  fire(): void {
    this.callback([], this);
  }
}

interface HarnessProps {
  scroller: boolean;
}

function Harness({ scroller }: HarnessProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFillScrollParent(ref);
  return createElement(
    'div',
    { 'data-testid': 'scroller', style: scroller ? { overflowY: 'auto', paddingBottom: '56px' } : undefined },
    createElement('div', { 'data-testid': 'card' }, createElement('div', { ref, 'data-testid': 'wrapper' })),
  );
}

const numberGetter = (attribute: string) =>
  function (this: HTMLElement) {
    return Number(this.dataset[attribute] ?? 0);
  };

function rectGetter(this: HTMLElement) {
  const top = Number(this.dataset.top ?? 0);
  const bottom = Number(this.dataset.bottom ?? 0);
  return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => undefined };
}

function setMetrics(element: HTMLElement, metrics: Record<string, number>) {
  Object.entries(metrics).forEach(([key, value]) => {
    element.dataset[key] = String(value);
  });
}

function renderHarness(scroller = true) {
  const { getByTestId, unmount } = render(createElement(Harness, { scroller }));
  return { scroller: getByTestId('scroller'), card: getByTestId('card'), wrapper: getByTestId('wrapper'), unmount };
}

describe('useFillScrollParent', () => {
  beforeEach(() => {
    FakeResizeObserver.instances = [];
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: numberGetter('ch') });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true, get: numberGetter('st') });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: rectGetter });
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.ch;
    delete document.body.dataset.bottom;
    document.documentElement.style.removeProperty('padding-bottom');
  });

  it('sets the fill variable from the scroll parent on mount', () => {
    const { wrapper } = renderHarness();
    expect(wrapper.style.getPropertyValue('--console-fill')).toBe('0px');
  });

  it('observes the scroll parent and the wrapper parent', () => {
    const { scroller, card } = renderHarness();
    expect(FakeResizeObserver.instances).toHaveLength(1);
    const observer = FakeResizeObserver.instances[0]!;
    expect(observer.observe).toHaveBeenCalledWith(scroller);
    expect(observer.observe).toHaveBeenCalledWith(card);
    expect(observer.observe).toHaveBeenCalledTimes(2);
  });

  it('re-sets the variable only when the height changes by more than a pixel', () => {
    const { scroller, card, wrapper } = renderHarness();
    const setProperty = vi.spyOn(wrapper.style, 'setProperty');
    const observer = FakeResizeObserver.instances[0]!;

    setMetrics(scroller, { ch: 800 });
    setMetrics(card, { bottom: 829 });
    setMetrics(wrapper, { top: 300, bottom: 812 });
    act(() => observer.fire());
    expect(wrapper.style.getPropertyValue('--console-fill')).toBe('427px');
    expect(setProperty).toHaveBeenCalledTimes(1);

    act(() => observer.fire());
    expect(setProperty).toHaveBeenCalledTimes(1);

    setMetrics(card, { bottom: 828 });
    act(() => observer.fire());
    expect(setProperty).toHaveBeenCalledTimes(1);
    expect(wrapper.style.getPropertyValue('--console-fill')).toBe('427px');

    setMetrics(card, { bottom: 809 });
    act(() => observer.fire());
    expect(setProperty).toHaveBeenCalledTimes(2);
    expect(wrapper.style.getPropertyValue('--console-fill')).toBe('447px');
  });

  it('grows the wrapper into free space when the column content is shorter than the parent', () => {
    const { scroller, card, wrapper } = renderHarness();
    const observer = FakeResizeObserver.instances[0]!;

    setMetrics(scroller, { ch: 1890, top: 90 });
    setMetrics(card, { bottom: 1008 });
    setMetrics(wrapper, { top: 479, bottom: 991 });
    act(() => observer.fire());
    expect(wrapper.style.getPropertyValue('--console-fill')).toBe('1428px');
  });

  it('falls back to the document element without a scrolling ancestor', () => {
    document.documentElement.style.paddingBottom = '0px';
    setMetrics(document.documentElement, { ch: 600 });
    setMetrics(document.body, { bottom: 900 });
    const { wrapper } = renderHarness(false);
    const observer = FakeResizeObserver.instances[0]!;
    expect(observer.observe).toHaveBeenCalledWith(document.documentElement);
    setMetrics(wrapper, { top: 100, bottom: 500 });
    act(() => observer.fire());
    expect(wrapper.style.getPropertyValue('--console-fill')).toBe('100px');
  });

  it('sets the variable once and skips the observer when ResizeObserver is undefined', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { wrapper } = renderHarness();
    expect(wrapper.style.getPropertyValue('--console-fill')).toBe('0px');
    expect(FakeResizeObserver.instances).toHaveLength(0);
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = renderHarness();
    unmount();
    expect(FakeResizeObserver.instances[0]!.disconnect).toHaveBeenCalled();
  });
});
