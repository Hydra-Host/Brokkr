import { describe, expect, it } from 'vitest';

import { blockReasons, findUid, parseGetaccess } from '../rmcp-plus.js';

describe('findUid branch invariants', () => {
  it('returns null when the username is absent', () => {
    const stdout =
      'ID  Name             Callin  Link Auth  IPMI Msg   Channel Priv Limit\n' +
      '1   ADMIN            true    true       true       ADMINISTRATOR\n' +
      '2   operator         true    true       true       OPERATOR\n';
    expect(findUid(stdout, 'missing-user')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(findUid('', 'ADMIN')).toBeNull();
  });

  it('is case-sensitive on the username match', () => {
    expect(findUid('1 ADMIN x x x x\n', 'admin')).toBeNull();
  });
});

describe('parseGetaccess branch invariants', () => {
  it('returns an empty record on empty input', () => {
    expect(parseGetaccess('')).toEqual({});
  });

  it('returns an empty record when only blank lines are present', () => {
    expect(parseGetaccess('\n\n\n')).toEqual({});
  });

  it('silently drops lines without a colon', () => {
    expect(parseGetaccess('just some narrative text\nfoo=bar\n')).toEqual({});
  });
});

describe('blockReasons branch invariants', () => {
  it('returns an empty list when access is well-formed', () => {
    expect(blockReasons({ 'IPMI Messaging': 'enabled', 'Privilege Level': 'ADMINISTRATOR' })).toEqual([]);
  });

  it('is case-insensitive on the messaging substring', () => {
    expect(blockReasons({ 'IPMI Messaging': 'ENABLED', 'Privilege Level': 'ADMINISTRATOR' })).toEqual([]);
  });

  it('is case-insensitive on the privilege substring', () => {
    expect(blockReasons({ 'IPMI Messaging': 'enabled', 'Privilege Level': 'administrator' })).toEqual([]);
  });

  it('emits messaging-first then privilege when both branches fire', () => {
    expect(blockReasons({ 'IPMI Messaging': 'disabled', 'Privilege Level': 'USER' })).toEqual([
      'IPMI messaging disabled on channel',
      'privilege limit USER below ADMINISTRATOR',
    ]);
  });

  it('renders unknown privilege when the field is missing', () => {
    expect(blockReasons({})).toEqual([
      'IPMI messaging disabled on channel',
      'privilege limit unknown below ADMINISTRATOR',
    ]);
  });

  it('emits messaging-only when privilege is good but messaging is bad', () => {
    expect(blockReasons({ 'IPMI Messaging': 'disabled', 'Privilege Level': 'ADMINISTRATOR' })).toEqual([
      'IPMI messaging disabled on channel',
    ]);
  });

  it('emits privilege-only when messaging is good but privilege is bad', () => {
    expect(blockReasons({ 'IPMI Messaging': 'enabled', 'Privilege Level': 'USER' })).toEqual([
      'privilege limit USER below ADMINISTRATOR',
    ]);
  });
});
