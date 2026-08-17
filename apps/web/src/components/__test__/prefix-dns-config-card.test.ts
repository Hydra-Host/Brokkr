import { describe, expect, it } from 'vitest';

import { apiToForm, formValuesToPayload } from '../prefix-dns-config-card';

describe('prefix DNS override form helpers', () => {
  it('apiToForm maps null serveDns to inherit', () => {
    const form = apiToForm(null, []);
    expect(form.serveDns).toBe('inherit');
  });

  it('apiToForm maps true serveDns to true string', () => {
    const form = apiToForm(true, ['8.8.8.8', '1.1.1.1']);
    expect(form.serveDns).toBe('true');
  });

  it('apiToForm maps false serveDns to false string', () => {
    const form = apiToForm(false, []);
    expect(form.serveDns).toBe('false');
  });

  it('apiToForm joins upstream overrides with comma-space', () => {
    const form = apiToForm(true, ['8.8.8.8', '1.1.1.1']);
    expect(form.upstreamOverride).toBe('8.8.8.8, 1.1.1.1');
  });

  it('formValuesToPayload converts inherit to null', () => {
    const payload = formValuesToPayload({ serveDns: 'inherit', upstreamOverride: '' });
    expect(payload.serveDns).toBeNull();
  });

  it('formValuesToPayload converts true string to boolean true', () => {
    const payload = formValuesToPayload({ serveDns: 'true', upstreamOverride: '' });
    expect(payload.serveDns).toBe(true);
  });

  it('formValuesToPayload converts false string to boolean false', () => {
    const payload = formValuesToPayload({ serveDns: 'false', upstreamOverride: '' });
    expect(payload.serveDns).toBe(false);
  });

  it('formValuesToPayload splits and trims upstream IPs', () => {
    const payload = formValuesToPayload({ serveDns: 'inherit', upstreamOverride: '8.8.8.8 , 1.1.1.1 ' });
    expect(payload.upstreamOverride).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('formValuesToPayload drops empty and invalid IPs', () => {
    const payload = formValuesToPayload({ serveDns: 'inherit', upstreamOverride: '8.8.8.8, , not-an-ip, 1.1.1.1' });
    expect(payload.upstreamOverride).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('round-trips through form and back', () => {
    const payload = formValuesToPayload(apiToForm(true, ['8.8.8.8', '1.1.1.1']));
    expect(payload.serveDns).toBe(true);
    expect(payload.upstreamOverride).toEqual(['8.8.8.8', '1.1.1.1']);
  });
});
