export function deriveGrpcAddress(
  address: string,
  opts: { insecure?: boolean; override?: string | undefined } = {},
): string {
  if (opts.override) {
    return opts.override;
  }
  return `${opts.insecure ? 'http' : 'https'}://${address}`;
}
