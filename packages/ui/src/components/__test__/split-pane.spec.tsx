import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SplitPane, type SplitPaneProps } from '../split-pane';

function renderPane(props: Partial<SplitPaneProps> = {}) {
  const onPrimaryWidthChange = vi.fn();
  render(
    <SplitPane
      primary={<div>job list</div>}
      secondary={<div>job detail</div>}
      defaultPrimaryWidth={300}
      minPrimaryWidth={200}
      maxPrimaryWidth={500}
      handleLabel="Resize job list"
      onPrimaryWidthChange={onPrimaryWidthChange}
      {...props}
    />,
  );
  return { handle: screen.getByRole('separator', { name: 'Resize job list' }), onPrimaryWidthChange };
}

function widthOf(handle: HTMLElement): number {
  return Number(handle.getAttribute('aria-valuenow'));
}

describe('SplitPane', () => {
  it('renders both panes with the default width on the handle', () => {
    const { handle } = renderPane();
    expect(screen.getByText('job list')).toBeInTheDocument();
    expect(screen.getByText('job detail')).toBeInTheDocument();
    expect(widthOf(handle)).toBe(300);
    expect(handle).toHaveAttribute('aria-valuemin', '200');
    expect(handle).toHaveAttribute('aria-valuemax', '500');
  });

  it('applies extra classes to the root', () => {
    const { handle } = renderPane({ className: 'h-96' });
    expect(handle.parentElement).toHaveClass('h-96');
  });

  it('clamps the default width into the allowed range', () => {
    const { handle } = renderPane({ defaultPrimaryWidth: 50 });
    expect(widthOf(handle)).toBe(200);
  });

  it('follows a pointer drag and reports the new width', () => {
    const { handle, onPrimaryWidthChange } = renderPane();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 140, pointerId: 1 });
    expect(widthOf(handle)).toBe(340);
    expect(onPrimaryWidthChange).toHaveBeenCalledWith(340);
  });

  it('clamps a drag past the maximum', () => {
    const { handle, onPrimaryWidthChange } = renderPane();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 });
    expect(widthOf(handle)).toBe(500);
    expect(onPrimaryWidthChange).toHaveBeenLastCalledWith(500);
  });

  it('clamps a drag past the minimum', () => {
    const { handle, onPrimaryWidthChange } = renderPane();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -5000, pointerId: 1 });
    expect(widthOf(handle)).toBe(200);
    expect(onPrimaryWidthChange).toHaveBeenLastCalledWith(200);
  });

  it('ignores pointer moves that are not part of a drag', () => {
    const { handle, onPrimaryWidthChange } = renderPane();
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });
    expect(widthOf(handle)).toBe(300);
    expect(onPrimaryWidthChange).not.toHaveBeenCalled();
  });

  it('stops following the pointer after the drag ends', () => {
    const { handle } = renderPane();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    expect(widthOf(handle)).toBe(300);
  });

  it('resizes with the arrow keys and pins with home and end', () => {
    const { handle, onPrimaryWidthChange } = renderPane();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(widthOf(handle)).toBe(316);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(widthOf(handle)).toBe(284);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(widthOf(handle)).toBe(200);
    fireEvent.keyDown(handle, { key: 'End' });
    expect(widthOf(handle)).toBe(500);
    expect(onPrimaryWidthChange).toHaveBeenLastCalledWith(500);
  });

  it('does not report a width that did not change', () => {
    const { handle, onPrimaryWidthChange } = renderPane({ defaultPrimaryWidth: 500 });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onPrimaryWidthChange).not.toHaveBeenCalled();
  });
});
