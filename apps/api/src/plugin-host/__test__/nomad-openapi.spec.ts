import { API_PREFIX } from '@hydrahost/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { generateApiDocument } from '../../common/openapi';

const NOMAD_PATHS = [
  `${API_PREFIX}/plugins/nomad/validate`,
  `${API_PREFIX}/plugins/nomad/plan`,
  `${API_PREFIX}/plugins/nomad/submit`,
  `${API_PREFIX}/plugins/nomad/status`,
] as const;

describe('nomad plugin OpenAPI visibility', () => {
  it('keeps Nomad paths out of the public hub OpenAPI while the plugin is disabled', async () => {
    const doc = await generateApiDocument(null, ['public']);
    const paths = Object.keys(doc.paths ?? {});
    for (const path of NOMAD_PATHS) {
      expect(paths, `public OpenAPI must omit ${path}`).not.toContain(path);
    }
  });
});
