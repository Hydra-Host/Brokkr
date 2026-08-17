// Operator-supplied and rendered in the browser — strip HTML / entity / Unicode-direction characters usable for spoofing.
export function sanitizeNickname(nickname: string): string {
  return nickname
    .replace(/[<>"'/\\]/g, '')
    .replace(/&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, '')
    .replace(/[‮‭‎‏]/g, '');
}
