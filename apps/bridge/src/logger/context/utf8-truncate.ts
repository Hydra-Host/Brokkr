export function truncateUtf8ToBytes(input: string, maxBytes: number): string {
  const buf = Buffer.from(input, 'utf-8');
  if (buf.length <= maxBytes) return input;

  let end = maxBytes;
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) {
    end--;
  }
  if (end > 0) {
    const lead = buf[end - 1];
    let needed = 0;
    if ((lead & 0xe0) === 0xc0) needed = 2;
    else if ((lead & 0xf0) === 0xe0) needed = 3;
    else if ((lead & 0xf8) === 0xf0) needed = 4;
    if (needed > 0) {
      if (end - 1 + needed <= maxBytes) {
        end = end - 1 + needed;
      } else {
        end--;
      }
    }
  }
  return buf.slice(0, end).toString('utf-8');
}

export function utf8ByteLength(input: string): number {
  return Buffer.byteLength(input, 'utf-8');
}
