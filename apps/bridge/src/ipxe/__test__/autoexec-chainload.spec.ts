import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const BRIDGE_ROOT = resolve(__dirname, '../../..');
const BAKED_CHAIN_LITERAL = 'https://brokkr.lan/api/chain';

function autoexec(): string {
  return readFileSync(resolve(BRIDGE_ROOT, 'boot/ipxe/autoexec-chainload.ipxe'), 'utf8');
}

function dockerfile(): string {
  return readFileSync(resolve(BRIDGE_ROOT, 'Dockerfile'), 'utf8');
}

describe('autoexec-chainload.ipxe baked chain host', () => {
  it('beacons a chain failure to the baked chain host', () => {
    const script = autoexec();
    expect(script).toContain(
      `imgfetch --name beacon "${BAKED_CHAIN_LITERAL}-unreachable?mac=\${netX/mac:hexhyp}&attempts=\${max_attempts}"`,
    );
    expect(script).not.toContain('${next-server}');
  });

  it('prints the baked chain url in the boot banner', () => {
    expect(autoexec()).toContain(`Chain URL:    ${BAKED_CHAIN_LITERAL}`);
  });

  it('keeps every chain endpoint on the literal the image build rewrites', () => {
    const script = autoexec();
    const hostHits = script.match(/https:\/\/brokkr\.lan[^\s"]*/g) ?? [];
    expect(hostHits.length).toBeGreaterThanOrEqual(3);
    for (const hit of hostHits) {
      expect(hit.startsWith(BAKED_CHAIN_LITERAL)).toBe(true);
    }
    expect(dockerfile()).toContain(`sed -i "s|${BAKED_CHAIN_LITERAL}|\${CHAIN_BASE_URL}/api/chain|g"`);
  });
});
