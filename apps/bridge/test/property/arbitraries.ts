import * as fc from 'fast-check';

export function aByteString(opts: { minSize?: number; maxSize?: number } = {}): fc.Arbitrary<Buffer> {
  const { minSize = 0, maxSize = 1024 } = opts;
  return fc.uint8Array({ minLength: minSize, maxLength: maxSize }).map((u8) => Buffer.from(u8));
}

const HEX_CHARS = '0123456789abcdef';

export function aHexString(length?: number): fc.Arbitrary<string> {
  if (length !== undefined) {
    return fc.array(fc.constantFrom(...HEX_CHARS), { minLength: length, maxLength: length }).map((cs) => cs.join(''));
  }
  return fc.array(fc.constantFrom(...HEX_CHARS), { minLength: 0, maxLength: 128 }).map((cs) => cs.join(''));
}

export function aSha256Hex(): fc.Arbitrary<string> {
  return aHexString(64);
}

export function anIpv4Address(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
    )
    .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);
}

export function anIpv6Address(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 })
    .map((parts) => parts.map((v) => v.toString(16)).join(':'));
}

export function anIpv4Cidr(): fc.Arbitrary<string> {
  return fc.tuple(anIpv4Address(), fc.integer({ min: 0, max: 32 })).map(([ip, prefix]) => `${ip}/${prefix}`);
}

export function aMacAddress(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0, max: 255 }), { minLength: 6, maxLength: 6 })
    .map((octets) => octets.map((v) => v.toString(16).padStart(2, '0')).join(':'));
}

const FSTAB_FS_TYPES = ['ext4', 'xfs', 'btrfs', 'vfat', 'swap', 'tmpfs', 'nfs'];
const FSTAB_OPT_TOKENS = [
  'defaults',
  'noatime',
  'nodiratime',
  'ro',
  'rw',
  'noexec',
  'nosuid',
  'nodev',
  'user',
  'auto',
  'noauto',
  'sync',
  'async',
  'discard',
];

function aFstabOpts(): fc.Arbitrary<string> {
  return fc
    .uniqueArray(fc.constantFrom(...FSTAB_OPT_TOKENS), { minLength: 1, maxLength: 4 })
    .map((opts) => opts.join(','));
}

export function aFstabDevice(): fc.Arbitrary<string> {
  const uuidForm = fc
    .tuple(aHexString(8), aHexString(4), aHexString(4), aHexString(4), aHexString(12))
    .map(([a, b, c, d, e]) => `UUID=${a}-${b}-${c}-${d}-${e}`);
  const devpathForm = fc.oneof(
    fc
      .tuple(
        fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
        fc.option(fc.integer({ min: 0, max: 9 }), { nil: undefined }),
      )
      .map(([letter, num]) => `/dev/sd${letter}${num === undefined ? '' : num}`),
    fc
      .tuple(fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 9 }))
      .map(([a, b, c]) => `/dev/nvme${a}n${b}p${c}`),
  );
  const labelForm = fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/).map((s) => `LABEL=${s}`);
  return fc.oneof(uuidForm, devpathForm, labelForm);
}

export function aFstabMountpoint(): fc.Arbitrary<string> {
  return fc.stringMatching(/^\/[a-zA-Z0-9_./-]{0,32}$/);
}

export function aFstabLine(): fc.Arbitrary<string> {
  const separator = fc.constantFrom(' ', '  ', '\t', ' \t', '   ');
  return fc
    .tuple(
      aFstabDevice(),
      aFstabMountpoint(),
      fc.constantFrom(...FSTAB_FS_TYPES),
      aFstabOpts(),
      fc.integer({ min: 0, max: 1 }),
      fc.integer({ min: 0, max: 2 }),
      separator,
      separator,
      separator,
      separator,
      separator,
    )
    .map(
      ([device, mount, fstype, opts, dump, fsck, s1, s2, s3, s4, s5]) =>
        `${device}${s1}${mount}${s2}${fstype}${s3}${opts}${s4}${dump}${s5}${fsck}`,
    );
}

export function aFstabBlob(): fc.Arbitrary<string> {
  const comment = fc.stringMatching(/^#[^\n]{0,64}$/);
  const blank = fc.constant('');
  const line = fc.oneof(aFstabLine(), comment, blank);
  return fc.array(line, { minLength: 0, maxLength: 12 }).map((lines) => lines.join('\n'));
}

const AAD_KEY = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/);
const AAD_SCALAR = fc.oneof(
  fc.string({ maxLength: 64 }),
  fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }),
  fc.boolean(),
  fc.constant(null),
);

export function anAadDict(): fc.Arbitrary<Record<string, unknown>> {
  return fc
    .uniqueArray(fc.tuple(AAD_KEY, AAD_SCALAR), { maxLength: 8, selector: ([k]) => k })
    .map((entries) => Object.fromEntries(entries) as Record<string, unknown>);
}

export function anAadDictWithInvalidValue(): fc.Arbitrary<Record<string, unknown>> {
  const invalidScalar = fc.oneof(
    aByteString({ maxSize: 16 }),
    fc.array(fc.integer(), { maxLength: 4 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 4 }), fc.integer(), { maxKeys: 2 }),
  );
  return fc.tuple(anAadDict(), AAD_KEY, invalidScalar).map(([base, key, bad]) => ({ ...base, [key]: bad }));
}
