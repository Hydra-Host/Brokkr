import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GettingStarted } from '../contract';

const FALLBACK = `# Getting Started

The hub repo's \`wiki/getting-started.md\` wasn't found, so this is a placeholder.

This page renders \`wiki/getting-started.md\` from your hub checkout
(\`HUB_REPO_PATH\`). To see the real guide, point \`HUB_REPO_PATH\` at a checkout
that has \`wiki/getting-started.md\` (e.g. \`@feat/boss\`).
`;

@Injectable()
export class DocsService {
  private readonly log = new Logger(DocsService.name);

  async gettingStarted(): Promise<GettingStarted> {
    const hubRepo = process.env.HUB_REPO_PATH;
    if (hubRepo) {
      const path = join(hubRepo, 'wiki', 'getting-started.md');
      try {
        const markdown = await readFile(path, 'utf8');
        return { markdown, source: path, found: true };
      } catch {
        this.log.warn(`getting-started.md not found at ${path}; serving placeholder`);
      }
    } else {
      this.log.warn('HUB_REPO_PATH unset; serving getting-started placeholder');
    }
    return { markdown: FALLBACK, source: 'fallback', found: false };
  }
}
