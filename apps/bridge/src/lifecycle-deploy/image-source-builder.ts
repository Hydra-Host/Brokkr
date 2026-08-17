import { HTTPSLayerError, layerUrl, validateLayerPayload } from './https-layer.service.js';

import { getLogger } from '../logger/logger.service';

const logDebug = (msg: string, ctx?: { jobId?: string }): void => void getLogger().debug(msg, ctx);

export interface OsLayer {
  [key: string]: unknown;
  layer: string;
  sha256: string;
  compression: string;
  stack_position: number;
}

export interface OsLayerBuildInput {
  [key: string]: unknown;
  layer?: string;
  sha256?: string;
  compression?: string;
  stack_position?: number | string;
}

export interface ImageSource {
  url: string;
  compression: string;
  sha256: string;
}

export interface CustomizationLayer {
  name: string;
  url: string;
  compression: string;
  stack_position: number;
  sha256: string;
}

export interface CustomizationsPayload {
  layers: CustomizationLayer[];
}

export class ImageSourceBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageSourceBuilderError';
  }
}

function unicodeDigitValue(cp: number): number {
  const isNd = /^\p{Nd}$/u;
  if (!isNd.test(String.fromCodePoint(cp))) return -1;
  let start = cp;
  while (start > 0 && isNd.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

const UNICODE_WS_CHARS =
  '\\u0009\\u000a\\u000b\\u000c\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const UNICODE_WHITESPACE = new RegExp(`^[${UNICODE_WS_CHARS}]+|[${UNICODE_WS_CHARS}]+$`, 'gu');

function coerceStackPosition(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const trimmed = value.replace(UNICODE_WHITESPACE, '');
    if (trimmed !== '' && /^[+-]?\p{Nd}+(_\p{Nd}+)*$/u.test(trimmed)) {
      const stripped = trimmed.replace(/_/g, '');
      let body = stripped;
      let sign = 1;
      if (body[0] === '+' || body[0] === '-') {
        if (body[0] === '-') sign = -1;
        body = body.slice(1);
      }
      let acc = 0;
      for (const ch of body) {
        acc = acc * 10 + unicodeDigitValue(ch.codePointAt(0) ?? -1);
      }
      return sign * acc;
    }
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new ImageSourceBuilderError(`stack_position must be int-coercible (got ${JSON.stringify(value)})`);
}

function sortByStackPosition(osLayers: readonly OsLayerBuildInput[]): OsLayerBuildInput[] {
  return [...osLayers].sort((a, b) => coerceStackPosition(a.stack_position) - coerceStackPosition(b.stack_position));
}

export async function buildHttpsImageSource(params: {
  jobId: string;
  osLayers: readonly OsLayerBuildInput[];
}): Promise<ImageSource> {
  const { jobId, osLayers } = params;
  if (osLayers.length === 0) {
    throw new HTTPSLayerError('os_layers is empty; HTTPS deploy needs at least a base layer');
  }

  for (const entry of osLayers) {
    validateLayerPayload(entry);
  }

  const sortedLayers = sortByStackPosition(osLayers);
  const base = sortedLayers[0];
  if (base === undefined) {
    throw new HTTPSLayerError('os_layers is empty; HTTPS deploy needs at least a base layer');
  }

  logDebug(`HTTPS base layer: ${base.layer} sha256=${base.sha256} compression=${base.compression}`, { jobId });

  return {
    url: layerUrl(base.sha256),
    compression: base.compression,
    sha256: base.sha256,
  };
}

export async function buildHttpsCustomizations(params: {
  jobId: string;
  osLayers: readonly OsLayerBuildInput[];
}): Promise<CustomizationsPayload | null> {
  const { jobId, osLayers } = params;
  if (osLayers.length <= 1) return null;

  for (const entry of osLayers) {
    validateLayerPayload(entry);
  }

  const sortedLayers = sortByStackPosition(osLayers);
  const customizationLayers = sortedLayers.slice(1).map((entry) => ({
    name: entry.layer,
    url: layerUrl(entry.sha256),
    compression: entry.compression,
    stack_position: coerceStackPosition(entry.stack_position),
    sha256: entry.sha256,
  }));

  const namesRepr = `[${customizationLayers.map((e) => `'${e.name}'`).join(', ')}]`;
  logDebug(`HTTPS customization layers: ${namesRepr}`, { jobId });

  return { layers: customizationLayers };
}
