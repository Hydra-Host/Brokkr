// Byte-canonical /admin/crons JSON — must stay byte-identical to the Python bridge's output (alphabetical keys, compact separators, trailing newline, ensure_ascii escaping, Python float/isoformat rendering).
import type { CronStateSnapshot } from './cron-state.js';

export function isoformatUtc(d: Date): string {
  const year = d.getUTCFullYear().toString().padStart(4, '0');
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  const hours = d.getUTCHours().toString().padStart(2, '0');
  const minutes = d.getUTCMinutes().toString().padStart(2, '0');
  const seconds = d.getUTCSeconds().toString().padStart(2, '0');
  const ms = d.getUTCMilliseconds();
  const base = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
  const frac = ms === 0 ? '' : `.${ms.toString().padStart(3, '0')}000`;
  return `${base}${frac}+00:00`;
}

function floatRepr(n: number): string {
  if (!Number.isFinite(n)) {
    // Never emit unparseable `NaN`/`Infinity` tokens.
    return JSON.stringify(n);
  }
  if (n === 0) {
    return Object.is(n, -0) ? '-0.0' : '0.0';
  }
  const expStr = n.toExponential();
  const negative = expStr.charAt(0) === '-';
  const body = negative ? expStr.slice(1) : expStr;
  const eIdx = body.indexOf('e');
  const mantissa = body.slice(0, eIdx);
  const sciExp = Number.parseInt(body.slice(eIdx + 1), 10);
  const dotIdx = mantissa.indexOf('.');
  const digits = dotIdx === -1 ? mantissa : mantissa.slice(0, dotIdx) + mantissa.slice(dotIdx + 1);
  const decpt = sciExp + 1;
  const sign = negative ? '-' : '';

  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) {
      return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
    }
    if (decpt >= digits.length) {
      return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
    }
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }

  const exp = decpt - 1;
  const expSign = exp < 0 ? '-' : '+';
  const expAbs = Math.abs(exp).toString().padStart(2, '0');
  const sciMantissa = digits.length === 1 ? digits : `${digits.charAt(0)}.${digits.slice(1)}`;
  return `${sign}${sciMantissa}e${expSign}${expAbs}`;
}

function jsonStringAsciiSafe(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 0x08:
        out += '\\b';
        continue;
      case 0x09:
        out += '\\t';
        continue;
      case 0x0a:
        out += '\\n';
        continue;
      case 0x0c:
        out += '\\f';
        continue;
      case 0x0d:
        out += '\\r';
        continue;
      case 0x22:
        out += '\\"';
        continue;
      case 0x5c:
        out += '\\\\';
        continue;
    }
    if (code < 0x20 || code >= 0x7f) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += s[i];
    }
  }
  return out + '"';
}

function renderTimestamp(d: Date | null): string {
  return d ? JSON.stringify(isoformatUtc(d)) : 'null';
}

function renderNullableString(s: string | null): string {
  return s === null ? 'null' : jsonStringAsciiSafe(s);
}

function renderCronStateJson(s: CronStateSnapshot): string {
  return (
    '{' +
    `"consecutive_failures":${s.consecutiveFailures},` +
    `"interval_seconds":${floatRepr(s.intervalSeconds)},` +
    `"last_error":${renderNullableString(s.lastError)},` +
    `"last_run_at":${renderTimestamp(s.lastRunAt)},` +
    `"last_success_at":${renderTimestamp(s.lastSuccessAt)},` +
    `"name":${jsonStringAsciiSafe(s.name)},` +
    `"next_run_at":${renderTimestamp(s.nextRunAt)},` +
    `"running":${s.running ? 'true' : 'false'}` +
    '}'
  );
}

export function renderCronStatesJson(states: readonly CronStateSnapshot[]): string {
  return `[${states.map(renderCronStateJson).join(',')}]\n`;
}
