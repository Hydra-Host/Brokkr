const LAB_TOKEN_KEY = 'lab-api-token';

export function labApiToken(): string {
  try {
    return localStorage.getItem(LAB_TOKEN_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function setLabApiToken(token: string): void {
  const trimmed = token.trim();
  try {
    if (trimmed) localStorage.setItem(LAB_TOKEN_KEY, trimmed);
    else localStorage.removeItem(LAB_TOKEN_KEY);
  } catch (error) {
    console.debug('lab token persist failed', error);
  }
}

export function withLabToken(path: string): string {
  const token = labApiToken();
  if (!token) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}
