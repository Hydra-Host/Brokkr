import { getSyncConfig } from '../sync/sync.config.js';

export const SUPPORTED_DECOMPRESSORS: Readonly<Record<string, string>> = {
  zstd: '--zstd',
  gzip: '-z',
};

export const IMAGE_FORMATS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  tar: { agent_op: 'deploy.restoreHttpsLayer' },
};

export class HTTPSLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HTTPSLayerError';
  }
}

export class HTTPSLayerConfigError extends HTTPSLayerError {
  constructor(message: string) {
    super(message);
    this.name = 'HTTPSLayerConfigError';
  }
}

export function sortedKeysRepr(record: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(record).sort();
  return `[${keys.map((k) => `'${k}'`).join(', ')}]`;
}

export function layerUrl(sha256: string, base?: string): string {
  const effectiveBase = (base ?? getSyncConfig().osLayerUrl).replace(/\/+$/, '');
  return `${effectiveBase}/sha256:${sha256}`;
}

export function decompressorFor(compression: unknown): string {
  // Crash on container types rather than stringifying them — TypeError propagates past validateLayerPayload.
  if (typeof compression === 'object' && compression !== null) {
    throw new TypeError(`unhashable type: ${Array.isArray(compression) ? "'list'" : "'dict'"}`);
  }
  if (typeof compression !== 'string') {
    throw new HTTPSLayerConfigError(
      `unsupported compression ${JSON.stringify(compression)}; supported: ${sortedKeysRepr(SUPPORTED_DECOMPRESSORS)}`,
    );
  }
  const flag = SUPPORTED_DECOMPRESSORS[compression];
  if (flag === undefined) {
    throw new HTTPSLayerConfigError(
      `unsupported compression '${compression}'; supported: ${sortedKeysRepr(SUPPORTED_DECOMPRESSORS)}`,
    );
  }
  return flag;
}

export function formatFor(layer: Readonly<Record<string, unknown>>): unknown {
  if (!('format' in layer)) return 'tar';
  return layer['format'];
}

export function agentOpFor(imageFormat: unknown): string {
  if (typeof imageFormat === 'object' && imageFormat !== null) {
    throw new TypeError(`unhashable type: ${Array.isArray(imageFormat) ? "'list'" : "'dict'"}`);
  }
  if (typeof imageFormat !== 'string') {
    throw new HTTPSLayerConfigError(
      `unsupported image format ${JSON.stringify(imageFormat)}; supported: ${sortedKeysRepr(IMAGE_FORMATS)}`,
    );
  }
  const entry = IMAGE_FORMATS[imageFormat];
  const op = entry?.['agent_op'];
  if (op === undefined) {
    throw new HTTPSLayerConfigError(
      `unsupported image format '${imageFormat}'; supported: ${sortedKeysRepr(IMAGE_FORMATS)}`,
    );
  }
  return op;
}

export function validateLayerPayload(layer: Readonly<Record<string, unknown>>): void {
  for (const field of ['layer', 'sha256', 'stack_position']) {
    if (!(field in layer)) {
      throw new HTTPSLayerConfigError(`layer missing required field '${field}': ${JSON.stringify(layer)}`);
    }
  }

  const imageFormat = formatFor(layer);
  agentOpFor(imageFormat);

  if (imageFormat === 'tar') {
    const compression = layer['compression'];
    if (!compression) {
      throw new HTTPSLayerConfigError(`tar layer missing 'compression' field: ${JSON.stringify(layer)}`);
    }
    decompressorFor(compression);
  }
}
