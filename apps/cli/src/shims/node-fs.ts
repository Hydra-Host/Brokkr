export function existsSync(): boolean {
  return false;
}
export function mkdirSync(): void {}
export function readFileSync(): string {
  return '{}';
}
export function writeFileSync(): void {}
export function appendFileSync(): void {}
export function unlinkSync(): void {}
export default {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
};
