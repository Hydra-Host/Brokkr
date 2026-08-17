import * as dgram from 'node:dgram';
import * as net from 'node:net';

import { FLAG_QR_RESPONSE, sliceQuestion } from './protocol.js';
import { MAX_TCP_MESSAGE_BYTES, TCP_LENGTH_PREFIX_BYTES, deframe, frameMessage } from './tcp-framing.js';

export const DEFAULT_UPSTREAMS = ['1.1.1.1', '8.8.8.8'] as const;
const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_PORT = 53;
const HEADER_LEN = 12;

export class ForwardError extends Error {}

export interface ForwardSocket {
  on(event: 'message', listener: (msg: Buffer, rinfo: dgram.RemoteInfo) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  send(msg: Buffer, port: number, address: string, callback?: (err?: Error | null) => void): void;
  close(): void;
}

export interface ForwardTcpSocket {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  connect(port: number, host: string, callback: () => void): unknown;
  write(buffer: Buffer): unknown;
  destroy(err?: Error): unknown;
  setTimeout(ms: number, callback: () => void): unknown;
}

export interface UpstreamAffinity {
  udp: number;
  tcp: number;
}

export interface ForwardOptions {
  upstreams?: readonly string[];
  timeoutMs?: number;
  port?: number;
  createSocket?: () => ForwardSocket;
  createTcpSocket?: () => ForwardTcpSocket;
  // Per-transport (a TC-bit TCP success must not bias the next UDP query) and instance-scoped by the caller — never a hidden module default.
  affinity: UpstreamAffinity;
}

function upstreamTryOrder(count: number, last: number): number[] {
  const order: number[] = [];
  if (last >= 0 && last < count) {
    order.push(last);
  }
  for (let i = 0; i < count; i++) {
    if (i !== last) {
      order.push(i);
    }
  }
  return order;
}

function lowerAscii(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) {
    if (out[i] >= 0x41 && out[i] <= 0x5a) {
      out[i] += 0x20;
    }
  }
  return out;
}

function acceptReplyCore(msg: Buffer, expected: { txnId: number; question: Buffer }): boolean {
  if (msg.length < HEADER_LEN) {
    return false;
  }
  if (msg.readUInt16BE(4) !== 1) {
    return false;
  }
  if (msg.readUInt16BE(0) !== expected.txnId) {
    return false;
  }
  if ((msg.readUInt16BE(2) & FLAG_QR_RESPONSE) === 0) {
    return false;
  }
  let replyQuestion: Buffer;
  try {
    replyQuestion = sliceQuestion(msg);
  } catch {
    return false;
  }
  if (replyQuestion.length < 4 || expected.question.length < 4) {
    return false;
  }
  const replyName = replyQuestion.subarray(0, replyQuestion.length - 4);
  const expName = expected.question.subarray(0, expected.question.length - 4);
  const replyFixed = replyQuestion.subarray(replyQuestion.length - 4);
  const expFixed = expected.question.subarray(expected.question.length - 4);
  return lowerAscii(replyName).equals(lowerAscii(expName)) && replyFixed.equals(expFixed);
}

function acceptReply(
  msg: Buffer,
  rinfo: dgram.RemoteInfo,
  expected: { upstream: string; port: number; txnId: number; question: Buffer },
): boolean {
  if (rinfo.address !== expected.upstream || rinfo.port !== expected.port) {
    return false;
  }
  return acceptReplyCore(msg, expected);
}

export function forwardQuery(query: Buffer, opts: ForwardOptions): Promise<Buffer> {
  const upstreams = opts.upstreams ?? DEFAULT_UPSTREAMS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const port = opts.port ?? DEFAULT_PORT;
  const createSocket = opts.createSocket ?? ((): ForwardSocket => dgram.createSocket('udp4'));
  const affinity = opts.affinity;

  const order = upstreamTryOrder(upstreams.length, affinity.udp);

  return new Promise<Buffer>((resolve, reject) => {
    const expectedTxnId = query.readUInt16BE(0);
    const expectedQuestion = sliceQuestion(query);
    let cursor = 0;

    const tryNext = (): void => {
      if (cursor >= order.length) {
        reject(new ForwardError(`all upstreams failed: ${JSON.stringify([...upstreams])}`));
        return;
      }
      const upstreamIndex = order[cursor];
      cursor += 1;
      const upstream = upstreams[upstreamIndex];

      const socket = createSocket();
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        socket.close();
      };

      const fallThrough = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        tryNext();
      };

      socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        if (settled) {
          return;
        }
        if (!acceptReply(msg, rinfo, { upstream, port, txnId: expectedTxnId, question: expectedQuestion })) {
          return;
        }
        settled = true;
        cleanup();
        affinity.udp = upstreamIndex;
        resolve(msg);
      });

      socket.on('error', fallThrough);

      timer = setTimeout(fallThrough, timeoutMs);

      socket.send(query, port, upstream, (err) => {
        if (err) {
          fallThrough();
        }
      });
    };

    tryNext();
  });
}

export function forwardQueryTcp(query: Buffer, opts: ForwardOptions): Promise<Buffer> {
  const upstreams = opts.upstreams ?? DEFAULT_UPSTREAMS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const port = opts.port ?? DEFAULT_PORT;
  const createTcpSocket = opts.createTcpSocket ?? ((): ForwardTcpSocket => new net.Socket());
  const affinity = opts.affinity;

  const order = upstreamTryOrder(upstreams.length, affinity.tcp);

  return new Promise<Buffer>((resolve, reject) => {
    const expectedTxnId = query.readUInt16BE(0);
    const expectedQuestion = sliceQuestion(query);
    const framedQuery = frameMessage(query);
    let cursor = 0;

    const tryNext = (): void => {
      if (cursor >= order.length) {
        reject(new ForwardError(`all upstreams failed (tcp): ${JSON.stringify([...upstreams])}`));
        return;
      }
      const upstreamIndex = order[cursor];
      cursor += 1;
      const upstream = upstreams[upstreamIndex];

      const socket = createTcpSocket();
      let settled = false;
      const chunks: Buffer[] = [];
      let bufferedLength = 0;

      const fallThrough = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        tryNext();
      };

      socket.setTimeout(timeoutMs, fallThrough);
      socket.on('error', fallThrough);
      socket.on('close', fallThrough);

      socket.on('data', (chunk: Buffer) => {
        if (settled) {
          return;
        }
        bufferedLength += chunk.length;
        if (bufferedLength > MAX_TCP_MESSAGE_BYTES + TCP_LENGTH_PREFIX_BYTES) {
          fallThrough();
          return;
        }
        chunks.push(chunk);
        const { messages } = deframe(Buffer.concat(chunks));
        if (messages.length === 0) {
          return;
        }
        const reply = messages[0];
        if (!acceptReplyCore(reply, { txnId: expectedTxnId, question: expectedQuestion })) {
          fallThrough();
          return;
        }
        settled = true;
        socket.destroy();
        affinity.tcp = upstreamIndex;
        resolve(Buffer.from(reply));
      });

      socket.connect(port, upstream, () => {
        if (settled) {
          return;
        }
        socket.write(framedQuery);
      });
    };

    tryNext();
  });
}
