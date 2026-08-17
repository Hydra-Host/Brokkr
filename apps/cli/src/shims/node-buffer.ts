/* eslint-disable @typescript-eslint/no-explicit-any */
let B: any;
if (typeof globalThis.Buffer !== 'undefined') {
  B = globalThis.Buffer;
} else {
  B = {
    alloc(size: number): Uint8Array {
      return new Uint8Array(size);
    },
    from(data: any): Uint8Array {
      if (typeof data === 'string') {
        return new TextEncoder().encode(data);
      }
      return new Uint8Array(data);
    },
    isBuffer(obj: any): boolean {
      return obj instanceof Uint8Array;
    },
  };
}

export const Buffer = B;
export default { Buffer: B };
