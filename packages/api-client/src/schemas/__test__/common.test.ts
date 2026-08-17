import {
  BooleanQueryParamSchema,
  IpxeBootUrlSchema,
  OperatingSystemSlugSchema,
  OS_SLUG_DESCRIPTION_PREFIX,
} from '../common';

describe('OperatingSystemSlugSchema', () => {
  it('has the description prefix required by the OpenAPI OS-slug injector', () => {
    expect(OperatingSystemSlugSchema.description?.startsWith(OS_SLUG_DESCRIPTION_PREFIX)).toBe(true);
  });
});

describe('BooleanQueryParamSchema', () => {
  it.each([
    ['false', false],
    ['0', false],
    ['true', true],
    ['1', true],
  ])('parses the string %j to %s', (input, expected) => {
    expect(BooleanQueryParamSchema.parse(input)).toBe(expected);
  });

  it.each([
    [true, true],
    [false, false],
  ])('passes through real boolean %s', (input, expected) => {
    expect(BooleanQueryParamSchema.parse(input)).toBe(expected);
  });

  it.each(['yes', 'no', 'False', 'TRUE', '', '2'])('rejects the unrecognized value %j', (input) => {
    expect(BooleanQueryParamSchema.safeParse(input).success).toBe(false);
  });

  it('is omittable when marked optional (default behavior preserved)', () => {
    const schema = BooleanQueryParamSchema.optional();
    expect(schema.parse(undefined)).toBeUndefined();
  });
});

describe('IpxeBootUrlSchema', () => {
  it.each([
    'http://boot.example.com/chain.ipxe',
    'https://boot.example.com/chain.ipxe',
    'http://10.0.0.5/boot.ipxe',
    'https://192.168.1.10:8443/chain.ipxe',
  ])('accepts the http(s) URL %j', (url) => {
    expect(IpxeBootUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    ['file scheme', 'file:///etc/passwd'],
    ['ftp scheme', 'ftp://boot.example.com/chain.ipxe'],
    ['tftp scheme', 'tftp://boot.example.com/chain.ipxe'],
    ['data scheme', 'data:text/plain,boot'],
    ['not a url', 'boot.example.com/chain.ipxe'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(IpxeBootUrlSchema.safeParse(url).success).toBe(false);
  });
});
