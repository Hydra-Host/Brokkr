import { buildCsv, csvRow } from '../csv';

describe('csvRow', () => {
  it('quotes every cell and doubles embedded quotes', () => {
    expect(csvRow(['a,b', 'say "hi"', ''])).toBe('"a,b","say ""hi""",""');
  });

  it('applies the same formula neutralization buildCsv does', () => {
    expect(csvRow(['=cmd'])).toBe(buildCsv(['=cmd'], []));
  });
});

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
