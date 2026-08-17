function rfc3986Encode(raw: string): string {
  const bytes = Buffer.from(raw, 'utf8');
  let out = '';
  for (const b of bytes) {
    const unreserved =
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      (b >= 0x30 && b <= 0x39) ||
      b === 0x2d ||
      b === 0x2e ||
      b === 0x5f ||
      b === 0x7e;
    if (unreserved) {
      out += String.fromCharCode(b);
    } else {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

export function sanitizeRedisUrl(url: string): string {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) {
    return url;
  }

  const rest = url.slice(schemeEnd + 3);
  const atPos = rest.lastIndexOf('@');
  if (atPos === -1) {
    return url;
  }

  const creds = rest.slice(0, atPos);
  const hostPart = rest.slice(atPos + 1);
  const colonPos = creds.indexOf(':');
  if (colonPos === -1) {
    return url;
  }

  const username = creds.slice(0, colonPos);
  const rawPassword = creds.slice(colonPos + 1);
  const encodedPassword = rfc3986Encode(rawPassword);

  return `${url.slice(0, schemeEnd + 3)}${username}:${encodedPassword}@${hostPart}`;
}
