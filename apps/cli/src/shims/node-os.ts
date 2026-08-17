export function homedir(): string {
  return '/home/user';
}
export function tmpdir(): string {
  return '/tmp';
}
export function platform(): string {
  return 'linux';
}
export default { homedir, tmpdir, platform };
