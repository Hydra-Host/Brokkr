import { access, readFile } from 'node:fs/promises';

import type { FileExists, ReadTextFile } from './ipxe-build-assert.js';

export const realFileExists: FileExists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

export const realReadTextFile: ReadTextFile = (path) =>
  readFile(path, 'utf8').then(
    (text) => text,
    () => null,
  );
