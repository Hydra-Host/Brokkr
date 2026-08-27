// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConfigTreeEntry } from '@/contract';

import { fieldProvenance } from '@/lib/config-tree';
import { ConfigField } from './config-field';

afterEach(cleanup);

const entry = (over: Partial<ConfigTreeEntry> & { path: string }): ConfigTreeEntry => {
  const base: ConfigTreeEntry = {
    label: 'Download timeout',
    group: 'ISO download',
    description: 'Whole-transfer deadline for each discovery image.',
    value: '3600',
    default: '3600',
    definedIn: [],
    secret: false,
    overridden: false,
    writable: true,
    kind: 'text',
    choices: [],
    danger: false,
    applyClass: 'reload-spoke',
    ...over,
  };
  return { ...base, overridden: over.overridden ?? base.value !== base.default };
};

function field(e: ConfigTreeEntry | undefined, extra: Partial<Parameters<typeof ConfigField>[0]> = {}) {
  return render(
    <ConfigField
      prov={fieldProvenance(e)}
      path="spoke.HTTPS_DOWNLOAD_TIMEOUT"
      label="Download timeout (s)"
      tag="HTTPS_DOWNLOAD_TIMEOUT"
      anchor="cfg-spoke-HTTPS_DOWNLOAD_TIMEOUT"
      {...extra}
    >
      {({ disabled, id }) => <input id={id} readOnly disabled={disabled} value={e?.value ?? ''} />}
    </ConfigField>,
  );
}

describe('ConfigField', () => {
  it('shows what the value was, so the change is readable without leaving the row', () => {
    field(entry({ path: 'x', value: '900', default: '3600', definedIn: ['stack.local.nix'] }));

    expect(screen.getByText('was 3600')).toBeTruthy();
    expect(screen.getByText('stack.local.nix')).toBeTruthy();
  });

  it('offers no revert on a knob sitting at its default', () => {
    field(entry({ path: 'x' }));

    expect(screen.queryByRole('button', { name: 'revert' })).toBeNull();
    expect(screen.queryByText(/^was /)).toBeNull();
  });

  it('reverts to the value Nix declares rather than to a blank field', () => {
    const onRevert = vi.fn();
    field(entry({ path: 'x', value: '900', default: '3600' }), { onRevert });

    fireEvent.click(screen.getByRole('button', { name: 'revert' }));
    expect(onRevert).toHaveBeenCalledOnce();
  });

  it('refuses to offer a revert when Nix declares no value to revert to', () => {
    const onRevert = vi.fn();
    field(entry({ path: 'x', value: '/checkouts/boss', default: '' }), { onRevert });

    expect(screen.queryByRole('button', { name: 'revert' })).toBeNull();
  });

  it('disables the control and names the variable when a pin holds the path', () => {
    field(entry({ path: 'x', value: 'false', default: 'true', pinnedBy: 'BROKKR_HTTPS_VERIFY' }));

    expect(screen.getByRole('textbox')).toHaveProperty('disabled', true);
    expect(screen.getByText('unset BROKKR_HTTPS_VERIFY to edit this here')).toBeTruthy();
  });

  it('marks a danger knob and a changed knob at the same time', () => {
    const { container } = field(entry({ path: 'x', value: 'false', default: 'true' }), { danger: true });

    expect(screen.getByText('⚠')).toBeTruthy();
    expect(container.querySelector('.bg-accent')).toBeTruthy();
  });

  it('leaves a secret undetermined rather than calling it unchanged', () => {
    field(entry({ path: 'x', value: '***', default: '***', secret: true }));

    expect(screen.getByText('secret')).toBeTruthy();
    expect(screen.queryByText(/^was /)).toBeNull();
  });

  it('marks an unsaved edit before any save has happened', () => {
    const { container } = field(entry({ path: 'x' }), { dirty: true });

    expect(container.querySelector('.bg-accent')).toBeTruthy();
  });

  it('says so when the config model does not declare the path at all', () => {
    field(undefined);

    expect(screen.getByTitle(/is not in the config model/)).toBeTruthy();
  });
});
