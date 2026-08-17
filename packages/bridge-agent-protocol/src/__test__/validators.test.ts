import { describe, expect, it } from 'vitest';

import { WorkId } from '../envelope.js';
import { operations } from '../operations/index.js';
import { DiskName, TargetPath } from '../operations/storage.js';

const VALID_OP = Object.keys(operations)[0]!;
const VALID_OP_2 = Object.keys(operations)[1]!;

describe('TargetPath', () => {
  describe('acceptance', () => {
    it.each([
      '/target',
      '/mnt',
      '/target/foo',
      '/mnt/data',
      '/target/foo/bar',
      '/mnt/a/b/c/d',
      '/target/some-dir',
      '/mnt/my_volume',
    ])('accepts %s', (path) => {
      expect(TargetPath.safeParse(path).success).toBe(true);
    });

    it('round-trips the parsed value unchanged', () => {
      const result = TargetPath.parse('/target/foo');
      expect(result).toBe('/target/foo');
    });
  });

  describe('rejection — wrong prefix', () => {
    it.each(['/', '/tmp', '/root', '/dev/sda', '/home/user', '/targets', '/mnts', '/Target', '/MNT', 'target', 'mnt'])(
      'rejects %s',
      (path) => {
        expect(TargetPath.safeParse(path).success).toBe(false);
      },
    );
  });

  describe('rejection — traversal and dot segments', () => {
    it.each(['/target/..', '/target/.', '/mnt/../etc/passwd', '/target/foo/../bar', '/mnt/./hidden'])(
      'rejects %s',
      (path) => {
        expect(TargetPath.safeParse(path).success).toBe(false);
      },
    );
  });

  describe('rejection — trailing junk / missing $ anchor regression', () => {
    it('rejects path with embedded newline', () => {
      expect(TargetPath.safeParse('/target\nmalicious').success).toBe(false);
    });

    it('rejects null byte in segment', () => {
      expect(TargetPath.safeParse('/mnt/foo/bar/\0').success).toBe(false);
    });
  });

  describe('rejection — structural violations', () => {
    it.each(['', '/target/', '/mnt/', '/target//double', '/mnt//a', '/target/foo/', '//target'])(
      'rejects %j',
      (path) => {
        expect(TargetPath.safeParse(path).success).toBe(false);
      },
    );
  });

  describe('rejection — relative paths', () => {
    it.each(['target/foo', 'mnt', './target', '../mnt', 'foo/bar'])('rejects relative path %s', (path) => {
      expect(TargetPath.safeParse(path).success).toBe(false);
    });
  });

  describe('rejection — non-string types', () => {
    it.each([42, null, undefined, true, {}, []])('rejects %j', (val) => {
      expect(TargetPath.safeParse(val).success).toBe(false);
    });
  });
});

describe('DiskName', () => {
  describe('acceptance — SATA/SCSI', () => {
    it.each(['sda', 'sdb', 'sdz', 'sdaa', 'sda1', 'sdb2', 'sdz99'])('accepts %s', (name) => {
      expect(DiskName.safeParse(name).success).toBe(true);
    });
  });

  describe('acceptance — NVMe', () => {
    it.each(['nvme0n1', 'nvme1n1', 'nvme0n1p1', 'nvme0n1p2', 'nvme10n2p3'])('accepts %s', (name) => {
      expect(DiskName.safeParse(name).success).toBe(true);
    });
  });

  describe('acceptance — MD RAID', () => {
    it.each(['md0', 'md1', 'md127'])('accepts %s', (name) => {
      expect(DiskName.safeParse(name).success).toBe(true);
    });
  });

  describe('rejection — /dev/ prefix must NOT be present', () => {
    it.each(['/dev/sda', '/dev/nvme0n1', '/dev/md0'])('rejects %s', (name) => {
      expect(DiskName.safeParse(name).success).toBe(false);
    });
  });

  describe('rejection — shell injection / metacharacters', () => {
    it.each(['sda; rm -rf /', 'sda && echo pwned', 'sda|cat /etc/passwd', 'sda`whoami`', 'sda$(id)', "sda'"])(
      'rejects %s',
      (name) => {
        expect(DiskName.safeParse(name).success).toBe(false);
      },
    );
  });

  describe('rejection — whitespace', () => {
    it.each(['sda ', ' sda', 'sda\t', 'sda\n'])('rejects %j', (name) => {
      expect(DiskName.safeParse(name).success).toBe(false);
    });
  });

  describe('rejection — unsupported device types', () => {
    it.each(['vda', 'xvda', 'loop0', 'dm-0', 'sr0', 'fd0'])('rejects %s', (name) => {
      expect(DiskName.safeParse(name).success).toBe(false);
    });
  });

  describe('rejection — structural', () => {
    it.each(['', 'SD', 'NVMe0n1', 'NVME0N1', 'sda/', 'md', 'nvmen1', 'nvme0n'])('rejects %s', (name) => {
      expect(DiskName.safeParse(name).success).toBe(false);
    });
  });

  describe('rejection — non-string types', () => {
    it.each([42, null, undefined, true])('rejects %j', (val) => {
      expect(DiskName.safeParse(val).success).toBe(false);
    });
  });
});

describe('compositeWorkId (via WorkId)', () => {
  describe('acceptance', () => {
    it('accepts uuid-shaped job_id with valid operation', () => {
      const id = `123e4567-e89b-42d3-a456-426614174000:${VALID_OP}`;
      expect(WorkId.safeParse(id).success).toBe(true);
    });

    it('accepts alphanumeric BullMQ job_id', () => {
      const id = `abc123:${VALID_OP}`;
      expect(WorkId.safeParse(id).success).toBe(true);
    });

    it('accepts hyphenated job_id', () => {
      const id = `my-job-42:${VALID_OP}`;
      expect(WorkId.safeParse(id).success).toBe(true);
    });

    it('accepts a second distinct operation name', () => {
      const id = `job1:${VALID_OP_2}`;
      expect(WorkId.safeParse(id).success).toBe(true);
    });

    it('accepts numeric-only job_id', () => {
      const id = `999:${VALID_OP}`;
      expect(WorkId.safeParse(id).success).toBe(true);
    });
  });

  describe('rejection — missing colon', () => {
    it('rejects when no colon is present', () => {
      expect(WorkId.safeParse('plainstring').success).toBe(false);
    });

    it('rejects job_id concatenated with operation but no colon', () => {
      expect(WorkId.safeParse(`abc123${VALID_OP}`).success).toBe(false);
    });
  });

  describe('rejection — empty parts', () => {
    it('rejects empty job_id (leading colon)', () => {
      const id = `:${VALID_OP}`;
      expect(WorkId.safeParse(id).success).toBe(false);
    });

    it('rejects empty operation (trailing colon)', () => {
      expect(WorkId.safeParse('abc123:').success).toBe(false);
    });

    it('rejects just a colon', () => {
      expect(WorkId.safeParse(':').success).toBe(false);
    });
  });

  describe('rejection — unknown operation in composite', () => {
    it.each(['job1:no.such.operation', 'job1:storage', 'job1:collectAll', 'job1:fake.fake'])(
      'rejects composite with unknown operation %s',
      (id) => {
        expect(WorkId.safeParse(id).success).toBe(false);
      },
    );
  });

  describe('rejection — forbidden characters in job_id', () => {
    it.each([
      `bad job:${VALID_OP}`,
      `bad/job:${VALID_OP}`,
      `bad.job:${VALID_OP}`,
      `bad@job:${VALID_OP}`,
      `bad!job:${VALID_OP}`,
    ])('rejects composite %s', (id) => {
      expect(WorkId.safeParse(id).success).toBe(false);
    });
  });

  describe('rejection — multiple colons', () => {
    it('uses first colon as split point — operation portion includes second colon', () => {
      const id = `job1:${VALID_OP}:extra`;
      expect(WorkId.safeParse(id).success).toBe(false);
    });
  });
});

describe('WorkId', () => {
  describe('acceptance — UUIDv4', () => {
    it.each([
      '123e4567-e89b-42d3-a456-426614174000',
      '550e8400-e29b-41d4-a716-446655440000',
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      '00000000-0000-4000-8000-000000000000',
    ])('accepts UUIDv4 %s', (uuid) => {
      expect(WorkId.safeParse(uuid).success).toBe(true);
    });
  });

  describe('acceptance — composite', () => {
    it('accepts valid composite', () => {
      expect(WorkId.safeParse(`abc:${VALID_OP}`).success).toBe(true);
    });
  });

  describe('UUID version agnosticism (Zod .uuid() accepts all versions)', () => {
    it.each([
      ['v1', '550e8400-e29b-11d4-a716-446655440000'],
      ['v3', '550e8400-e29b-31d4-a716-446655440000'],
      ['v5', '550e8400-e29b-51d4-a716-446655440000'],
    ])('accepts %s UUID (Zod .uuid() is version-agnostic)', (_label, uuid) => {
      expect(WorkId.safeParse(uuid).success).toBe(true);
    });
  });

  describe('rejection — garbage', () => {
    it.each(['', 'not-a-uuid', '12345', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', 'hello world', '   '])(
      'rejects %j',
      (val) => {
        expect(WorkId.safeParse(val).success).toBe(false);
      },
    );
  });

  describe('rejection — non-string types', () => {
    it.each([42, null, undefined, true, {}, []])('rejects %j', (val) => {
      expect(WorkId.safeParse(val).success).toBe(false);
    });
  });
});
