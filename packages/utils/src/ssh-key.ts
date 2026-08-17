export function normalizeSshKey(publicKey: string): string {
  return publicKey
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('')
    .trim();
}
