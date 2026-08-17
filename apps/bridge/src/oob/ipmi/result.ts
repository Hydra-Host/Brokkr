export interface IPMIResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly returncode: number | null;
  readonly command: readonly string[];
  readonly cipherUsed: string | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export function resultError(result: IPMIResult): string {
  if (result.stderr) return result.stderr;
  if (result.timedOut) return 'Command timed out';
  if (result.ok) return '';
  return `Command failed (rc=${result.returncode})`;
}
