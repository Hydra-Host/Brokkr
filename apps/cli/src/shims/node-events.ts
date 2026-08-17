type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private _events: Record<string, Listener[]> = {};

  on(event: string, fn: Listener): this {
    (this._events[event] ??= []).push(fn);
    return this;
  }

  addListener(event: string, fn: Listener): this {
    return this.on(event, fn);
  }

  once(event: string, fn: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, fn: Listener): this {
    const list = this._events[event];
    if (list) this._events[event] = list.filter((f) => f !== fn);
    return this;
  }

  removeListener(event: string, fn: Listener): this {
    return this.off(event, fn);
  }

  removeAllListeners(event?: string): this {
    if (event) delete this._events[event];
    else this._events = {};
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const list = this._events[event];
    if (!list || list.length === 0) return false;
    for (const fn of list) fn(...args);
    return true;
  }

  listeners(event: string): Listener[] {
    return this._events[event] ?? [];
  }

  listenerCount(event: string): number {
    return (this._events[event] ?? []).length;
  }

  setMaxListeners(): this {
    return this;
  }

  getMaxListeners(): number {
    return Infinity;
  }

  rawListeners(event: string): Listener[] {
    return this.listeners(event);
  }

  eventNames(): string[] {
    return Object.keys(this._events);
  }

  prependListener(event: string, fn: Listener): this {
    (this._events[event] ??= []).unshift(fn);
    return this;
  }

  prependOnceListener(event: string, fn: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.prependListener(event, wrapped);
  }
}

export default EventEmitter;
