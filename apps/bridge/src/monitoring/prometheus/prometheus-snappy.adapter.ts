import * as snappy from 'snappyjs';

import type { SnappyCompressor } from './prometheus.service';

export function createSnappyJsCompressor(): SnappyCompressor {
  return {
    compress(input: Uint8Array): Uint8Array {
      return snappy.compress<Uint8Array>(input);
    },
  };
}
