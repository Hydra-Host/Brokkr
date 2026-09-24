export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  closeCount = 0;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }

  static latest(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error('no EventSource was opened');
    return source;
  }

  close(): void {
    this.closeCount += 1;
  }

  emit(frame: unknown): void {
    this.emitRaw(JSON.stringify(frame));
  }

  emitRaw(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}
