import { getErrorMessage } from 'src/common/error-utils';
import { z } from 'zod';

// `createdAt` is set at insert but rows appear at commit, so delivery is at-least-once only for commits landing
// within `lookbackMs` of the scan position: dedupe on id, and a txn open longer than that is still missed.

const CURSOR_VERSION = 1;

/** Sorts before every real row sharing the instant, so a synthesized floor never hides one. */
const MIN_ID = '';

export interface EventKey {
  createdAt: Date;
  id: string;
}

export interface CursorState {
  /** Frozen lower bound for the current synchronisation cycle. */
  replayFrom: EventKey;
  /** High-water mark actually reached; advances every page. */
  scanAfter: EventKey;
}

export class CursorFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorFormatError';
  }
}

const eventKeySchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string(),
});

const cursorPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  replayFrom: eventKeySchema,
  scanAfter: eventKeySchema,
});

/** Base64 JSON with a version marker — not delimiter-joined, since ISO-8601 contains colons. */
export function encodeCursor(state: CursorState): string {
  const payload = {
    v: CURSOR_VERSION,
    replayFrom: { createdAt: state.replayFrom.createdAt.toISOString(), id: state.replayFrom.id },
    scanAfter: { createdAt: state.scanAfter.createdAt.toISOString(), id: state.scanAfter.id },
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CursorState {
  // Buffer's base64url decoder drops stray characters instead of failing, so only a round-trip rejects them.
  const decoded = Buffer.from(raw, 'base64url');
  if (decoded.toString('base64url') !== raw) {
    throw new CursorFormatError('Cursor is not canonical base64url');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoded.toString('utf8'));
  } catch (error) {
    throw new CursorFormatError(`Cursor is not base64-encoded JSON: ${getErrorMessage(error)}`);
  }

  const parsed = cursorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    // Blame the version only when the version is what failed: a v1 cursor with an unparseable
    // timestamp reported as a version mismatch sends the reader hunting a compatibility problem.
    if (parsed.error.issues.some((issue) => issue.path[0] === 'v')) {
      throw new CursorFormatError(`Cursor is not a version ${CURSOR_VERSION} cursor`);
    }

    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new CursorFormatError(`Cursor payload is malformed — ${detail}`);
  }

  return {
    replayFrom: { createdAt: new Date(parsed.data.replayFrom.createdAt), id: parsed.data.replayFrom.id },
    scanAfter: { createdAt: new Date(parsed.data.scanAfter.createdAt), id: parsed.data.scanAfter.id },
  };
}

/** A fresh consumer with no cursor. */
export function initialCursor(now: Date, lookbackMs: number): CursorState {
  return cursorAt(new Date(now.getTime() - lookbackMs));
}

/** A cycle opened at a caller-chosen floor, for a consumer asking for history rather than the tail. */
export function cursorAt(from: Date): CursorState {
  return startCycle(from.getTime());
}

export function advanceCursor(
  state: CursorState,
  lastRow: EventKey | undefined,
  pageWasFull: boolean,
  lookbackMs: number,
): CursorState {
  const scanAfter =
    lastRow && compareKeys(lastRow, state.scanAfter) > 0 ? cloneKey(lastRow) : cloneKey(state.scanAfter);

  if (pageWasFull) {
    return { replayFrom: cloneKey(state.replayFrom), scanAfter };
  }

  // Restarting before the high-water mark has cleared a whole lookback would re-read the same window on
  // every poll of an idle feed, so the exhausted cycle stays open until a restart can move the floor.
  const floor = scanAfter.createdAt.getTime() - lookbackMs;
  if (floor <= state.replayFrom.createdAt.getTime()) {
    return { replayFrom: cloneKey(state.replayFrom), scanAfter };
  }

  return startCycle(floor);
}

export function isCursorExpired(state: CursorState, retentionFloor: Date): boolean {
  return state.replayFrom.createdAt.getTime() < retentionFloor.getTime();
}

function startCycle(fromMs: number): CursorState {
  return {
    replayFrom: { createdAt: new Date(fromMs), id: MIN_ID },
    scanAfter: { createdAt: new Date(fromMs), id: MIN_ID },
  };
}

function cloneKey(key: EventKey): EventKey {
  return { createdAt: new Date(key.createdAt.getTime()), id: key.id };
}

function compareKeys(left: EventKey, right: EventKey): number {
  const byTime = left.createdAt.getTime() - right.createdAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }

  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
