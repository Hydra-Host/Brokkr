export const TCP_LENGTH_PREFIX_BYTES = 2;
export const MAX_TCP_MESSAGE_BYTES = 0xffff;

export function frameMessage(payload: Buffer): Buffer {
  if (payload.length > MAX_TCP_MESSAGE_BYTES) {
    throw new RangeError(`DNS-over-TCP message too large: ${payload.length} > ${MAX_TCP_MESSAGE_BYTES}`);
  }
  const prefix = Buffer.alloc(TCP_LENGTH_PREFIX_BYTES);
  prefix.writeUInt16BE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

export function deframe(buffer: Buffer) {
  const messages: Buffer[] = [];
  let offset = 0;

  for (;;) {
    if (offset + TCP_LENGTH_PREFIX_BYTES > buffer.length) {
      break;
    }
    const length = buffer.readUInt16BE(offset);
    const bodyStart = offset + TCP_LENGTH_PREFIX_BYTES;
    const bodyEnd = bodyStart + length;
    if (bodyEnd > buffer.length) {
      break;
    }
    messages.push(buffer.subarray(bodyStart, bodyEnd));
    offset = bodyEnd;
  }

  return { messages, remainder: buffer.subarray(offset) };
}
