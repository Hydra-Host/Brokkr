import { readControl } from '../shell-server';


describe('readControl', () => {
  it('accepts a valid input frame', () => {
    expect(readControl(JSON.stringify({ i: 'ls\r' }))).toEqual({ i: 'ls\r' });
  });

  it('accepts a valid resize frame with positive integer dimensions', () => {
    expect(readControl(JSON.stringify({ r: [120, 40] }))).toEqual({ r: [120, 40] });
  });

  it('drops non-JSON garbage', () => {
    expect(readControl('not json{')).toBeNull();
  });

  it('drops a resize frame with non-positive dimensions', () => {
    expect(readControl(JSON.stringify({ r: [0, 0] }))).toBeNull();
    expect(readControl(JSON.stringify({ r: [-1, 40] }))).toBeNull();
  });

  it('drops a resize frame with non-integer or wrong-arity dimensions', () => {
    expect(readControl(JSON.stringify({ r: [80.5, 24] }))).toBeNull();
    expect(readControl(JSON.stringify({ r: [80] }))).toBeNull();
    expect(readControl(JSON.stringify({ r: ['80', '24'] }))).toBeNull();
  });

  it('drops a frame whose input is not a string', () => {
    expect(readControl(JSON.stringify({ i: 123 }))).toBeNull();
  });
});
