export function fileURLToPath(url: string): string {
  return url.replace('file://', '');
}
export default { fileURLToPath };
