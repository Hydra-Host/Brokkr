import { extractCookies, mergeCookies } from '../auth.js';

function responseWithSetCookies(values: string[]): Response {
  const headers = new Headers();
  for (const v of values) headers.append('set-cookie', v);
  return new Response(null, { headers });
}

function responseWithoutGetSetCookie(combined: string): Response {
  const res = new Response(null, { headers: { 'set-cookie': combined } });
  Object.defineProperty(res.headers, 'getSetCookie', { value: undefined, configurable: true });
  return res;
}

describe('extractCookies', () => {
  it('strips attributes after the first semicolon, keeping only name=value', () => {
    const res = responseWithSetCookies(['session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax']);
    expect(extractCookies(res)).toEqual(['session=abc123']);
  });

  it('returns each Set-Cookie header as its own name=value entry, preserving order', () => {
    const res = responseWithSetCookies(['a=1; Path=/', 'b=2; HttpOnly', 'c=3; Secure']);
    expect(extractCookies(res)).toEqual(['a=1', 'b=2', 'c=3']);
  });

  it('trims surrounding whitespace from the name=value pair', () => {
    const res = responseWithSetCookies(['  token=xyz  ; Path=/']);
    expect(extractCookies(res)).toEqual(['token=xyz']);
  });

  it('returns an empty array when there are no Set-Cookie headers', () => {
    expect(extractCookies(new Response(null))).toEqual([]);
  });

  it('keeps a cookie value that itself contains an "=" intact (only first ; splits)', () => {
    const res = responseWithSetCookies(['jwt=a.b=c; Path=/; HttpOnly']);
    expect(extractCookies(res)).toEqual(['jwt=a.b=c']);
  });

  describe('raw set-cookie fallback (getSetCookie unavailable)', () => {
    it('splits a comma-combined header on the cookie boundary and strips attributes', () => {
      const res = responseWithoutGetSetCookie('a=1; Path=/, b=2; HttpOnly');
      expect(extractCookies(res)).toEqual(['a=1', 'b=2']);
    });

    it('does NOT split on the comma inside an Expires date attribute', () => {
      const res = responseWithoutGetSetCookie(
        'sid=xyz; Path=/; Expires=Wed, 21 Oct 2025 07:28:00 GMT, next=val; HttpOnly',
      );
      expect(extractCookies(res)).toEqual(['sid=xyz', 'next=val']);
    });

    it('returns an empty array when the raw header is absent too', () => {
      const res = new Response(null);
      Object.defineProperty(res.headers, 'getSetCookie', { value: undefined, configurable: true });
      expect(extractCookies(res)).toEqual([]);
    });
  });
});

describe('mergeCookies', () => {
  it('appends a brand-new cookie after the existing ones, preserving order', () => {
    expect(mergeCookies('a=1; b=2', ['c=3'])).toBe('a=1; b=2; c=3');
  });

  it('overwrites an existing cookie value on name collision (new wins)', () => {
    expect(mergeCookies('a=1; b=2', ['b=9'])).toBe('a=1; b=9');
  });

  it('keeps the original position of an overwritten cookie (Map insertion order)', () => {
    expect(mergeCookies('a=1; b=2; c=3', ['b=99'])).toBe('a=1; b=99; c=3');
  });

  it('handles multiple new cookies: overwrites collisions and appends the rest', () => {
    expect(mergeCookies('a=1; b=2', ['b=20', 'd=4'])).toBe('a=1; b=20; d=4');
  });

  it('returns only the new cookies when existing is empty', () => {
    expect(mergeCookies('', ['x=1', 'y=2'])).toBe('x=1; y=2');
  });

  it('ignores malformed parts with no "=" (or leading "=") in existing and new', () => {
    expect(mergeCookies('a=1; junk; =bad', ['b=2', 'alsojunk'])).toBe('a=1; b=2');
  });

  it('when newCookies repeats a name, the last occurrence wins', () => {
    expect(mergeCookies('a=1', ['a=2', 'a=3'])).toBe('a=3');
  });
});
