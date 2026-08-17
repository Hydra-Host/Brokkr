const SENSITIVE_KEY = /^(password|newpassword|oldpassword|token|secret|passphrase)$/i;
const MASK = '********';

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? MASK : redactSensitive(val);
    }
    return out;
  }
  return value;
}
