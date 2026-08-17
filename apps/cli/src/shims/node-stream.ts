import { EventEmitter } from './node-events.js';

export class Stream extends EventEmitter {
  pipe<T extends Stream>(dest: T): T {
    return dest;
  }
}

export class Writable extends Stream {
  writable = true;
  write(_chunk: unknown, _encoding?: string, _cb?: () => void): boolean {
    return true;
  }
  end(): this {
    return this;
  }
  destroy(): this {
    return this;
  }
}

export class Readable extends Stream {
  readable = true;
  read(): null {
    return null;
  }
  destroy(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

export class PassThrough extends Stream {
  write(_chunk: unknown): boolean {
    return true;
  }
  end(): this {
    return this;
  }
}

export default Stream;
