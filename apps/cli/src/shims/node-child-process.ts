export function execFileSync(): Buffer {
  return Buffer.alloc(0);
}
export function execSync(): Buffer {
  return Buffer.alloc(0);
}
export function spawn(): never {
  throw new Error('child_process.spawn is not available in the browser');
}
export function exec(): never {
  throw new Error('child_process.exec is not available in the browser');
}
