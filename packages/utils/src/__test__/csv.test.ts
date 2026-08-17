import { buildCsv } from '../csv';

describe('buildCsv formula-injection neutralization', () => {
  it('prefixes a single quote to cells starting with =', () => {
    expect(buildCsv(['h'], [['=cmd']])).toBe('"h"\n"\'=cmd"');
  });

  it('prefixes a single quote to cells starting with +', () => {
    expect(buildCsv(['h'], [['+cmd']])).toBe('"h"\n"\'+cmd"');
  });

  it('prefixes a single quote to cells starting with -', () => {
    expect(buildCsv(['h'], [['-cmd']])).toBe('"h"\n"\'-cmd"');
  });

  it('prefixes a single quote to cells starting with @', () => {
    expect(buildCsv(['h'], [['@cmd']])).toBe('"h"\n"\'@cmd"');
  });

  it('prefixes a single quote to cells starting with a tab', () => {
    expect(buildCsv(['h'], [['\tcmd']])).toBe('"h"\n"\'\tcmd"');
  });

  it('prefixes a single quote to cells starting with a carriage return', () => {
    expect(buildCsv(['h'], [['\rcmd']])).toBe('"h"\n"\'\rcmd"');
  });

  it('leaves a normal cell unchanged', () => {
    expect(buildCsv(['h'], [['normal']])).toBe('"h"\n"normal"');
  });
});
