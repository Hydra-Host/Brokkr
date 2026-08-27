// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Stepper } from './stepper';

afterEach(cleanup);

describe('Stepper', () => {
  it('steps in both directions when nothing holds the value', () => {
    render(<Stepper label="Stack slot" tag="stack.slot" value={3} min={0} max={9} onChange={vi.fn()} />);

    expect(screen.getByRole<HTMLButtonElement>('button', { name: '−' }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '+' }).disabled).toBe(false);
  });

  it('goes inert in both directions when a pin holds the path, and says which one', () => {
    render(
      <Stepper
        label="Stack slot"
        tag="stack.slot"
        value={3}
        min={0}
        max={9}
        locked="held by BROKKR_PIN_STACK_SLOT"
        onChange={vi.fn()}
      />,
    );

    for (const name of ['−', '+']) {
      const btn = screen.getByRole<HTMLButtonElement>('button', { name });
      expect(btn.disabled).toBe(true);
      expect(btn.title).toBe('held by BROKKR_PIN_STACK_SLOT');
    }
  });
});
