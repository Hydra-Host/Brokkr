export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasErrnoCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}
