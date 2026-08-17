const UINT64_MASK = (1n << 64n) - 1n;

export function encodeVarint(value: bigint): Uint8Array {
  let v = value < 0n ? value & UINT64_MASK : value;
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v & 0x7fn));
  return Uint8Array.from(out);
}

function tag(field: number, wire: number): Uint8Array {
  return encodeVarint(BigInt((field << 3) | wire));
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const utf8Encoder = new TextEncoder();

export class Label {
  constructor(
    public name: string = '',
    public value: string = '',
  ) {}

  serializeToString(): Uint8Array {
    const parts: Uint8Array[] = [];
    if (this.name) {
      const nameBytes = utf8Encoder.encode(this.name);
      parts.push(tag(1, 2));
      parts.push(encodeVarint(BigInt(nameBytes.length)));
      parts.push(nameBytes);
    }
    if (this.value) {
      const valueBytes = utf8Encoder.encode(this.value);
      parts.push(tag(2, 2));
      parts.push(encodeVarint(BigInt(valueBytes.length)));
      parts.push(valueBytes);
    }
    return concat(parts);
  }
}

export class Sample {
  constructor(
    public value: number = 0,
    public timestamp: bigint = 0n,
  ) {}

  serializeToString(): Uint8Array {
    const parts: Uint8Array[] = [];
    parts.push(tag(1, 1));
    const doubleBuf = new Uint8Array(8);
    new DataView(doubleBuf.buffer).setFloat64(0, this.value, true);
    parts.push(doubleBuf);
    parts.push(tag(2, 0));
    parts.push(encodeVarint(this.timestamp));
    return concat(parts);
  }
}

export class TimeSeries {
  private readonly _labels: Label[] = [];
  private readonly _samples: Sample[] = [];

  addLabel(label: Label): void {
    this._labels.push(label);
  }

  addSample(sample: Sample): void {
    this._samples.push(sample);
  }

  get labels(): readonly Label[] {
    return this._labels;
  }

  get samples(): readonly Sample[] {
    return this._samples;
  }

  serializeToString(): Uint8Array {
    const labelTag = tag(1, 2);
    const sampleTag = tag(2, 2);
    const parts: Uint8Array[] = [];
    for (const label of this._labels) {
      const enc = label.serializeToString();
      parts.push(labelTag);
      parts.push(encodeVarint(BigInt(enc.length)));
      parts.push(enc);
    }
    for (const sample of this._samples) {
      const enc = sample.serializeToString();
      parts.push(sampleTag);
      parts.push(encodeVarint(BigInt(enc.length)));
      parts.push(enc);
    }
    return concat(parts);
  }
}

export class WriteRequest {
  private readonly _timeseries: TimeSeries[] = [];

  addTimeseries(ts: TimeSeries): void {
    this._timeseries.push(ts);
  }

  get timeseries(): readonly TimeSeries[] {
    return this._timeseries;
  }

  serializeToString(): Uint8Array {
    const tsTag = tag(1, 2);
    const parts: Uint8Array[] = [];
    for (const ts of this._timeseries) {
      const enc = ts.serializeToString();
      parts.push(tsTag);
      parts.push(encodeVarint(BigInt(enc.length)));
      parts.push(enc);
    }
    return concat(parts);
  }
}
