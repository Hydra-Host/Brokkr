/**
 * Privilege-level fallback for BMC users capped below ADMINISTRATOR. ipmitool asks for
 * ADMINISTRATOR when `-L` is unset, and a capped user's refusal surfaces as a generic
 * "ipmitool failed rc=1", so a matching stderr is retried once with `-L OPERATOR`.
 *
 * Every signature below is emitted while the session is still opening, so the verb never reached
 * the BMC — that is what keeps the retry safe for non-idempotent verbs like `power cycle`.
 * `insufficient privilege level` is deliberately absent: it means the command needs MORE
 * privilege, so dropping to OPERATOR only fails harder.
 *
 * Byte-for-byte counterpart of `bridge/adapters/ipmi/privilege.py`.
 */

/** ipmitool's own name for the level, passed verbatim as `-L OPERATOR`. */
export const PRIVILEGE_FALLBACK_LEVEL = 'OPERATOR';

export const PRIVILEGE_FLAG = '-L';

/** lowercase; matched as substrings against a lowercased stderr */
export const PRIVILEGE_DENIED_SIGNATURES: readonly string[] = [
  'unauthorized role requested',
  'requested privilege level exceeds limit',
  'set session privilege level to administrator failed',
];

/** True if `stderr` shows ipmitool was refused for asking too high a privilege. */
export function isPrivilegeDenied(stderr: string): boolean {
  if (!stderr) return false;
  const lowered = stderr.toLowerCase();
  return PRIVILEGE_DENIED_SIGNATURES.some((sig) => lowered.includes(sig));
}

/** True if the argv already pins a privilege level; a false positive only suppresses the retry. */
export function hasPrivilegeFlag(command: readonly string[]): boolean {
  return command.some((arg) => arg.startsWith(PRIVILEGE_FLAG));
}

/**
 * Insert `-L <level>` after the binary, matching `withCsvFlag`'s position so the flag stays clear
 * of the operation words at the tail. Empty argv is returned unchanged.
 */
export function withPrivilegeLevel(command: readonly string[], level: string = PRIVILEGE_FALLBACK_LEVEL): string[] {
  const [bin, ...rest] = command;
  if (bin === undefined) return [];
  return [bin, PRIVILEGE_FLAG, level, ...rest];
}
