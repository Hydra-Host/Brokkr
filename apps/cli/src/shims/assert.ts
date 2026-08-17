function assert(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(message ?? 'Assertion failed');
}
assert.ok = assert;
assert.equal = (a: unknown, b: unknown, msg?: string) => {
  if (a != b) throw new Error(msg ?? `${a} != ${b}`);
};
assert.strictEqual = (a: unknown, b: unknown, msg?: string) => {
  if (a !== b) throw new Error(msg ?? `${a} !== ${b}`);
};
export default assert;
