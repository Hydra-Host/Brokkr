import { randomUUID, timingSafeEqual } from 'node:crypto';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import SSHConfigParser from 'ssh-config';
import { Client, ClientChannel, ConnectConfig, utils as ssh2Utils } from 'ssh2';

import { getSshConfig, SSHConfig } from './ssh.config.js';

import { getLogger } from '../logger/logger.service';

const APP_CLASS = 'adapters-ssh';

const SSH_RETRY_ATTEMPTS = 7;
const SSH_RETRY_DELAYS_SECONDS = [1, 2, 4, 8, 16, 16];

function logDebug(msg: string, ctx?: Record<string, unknown>): void {
  void getLogger().debug(msg, ctx);
}
function logInfo(msg: string, ctx?: Record<string, unknown>): void {
  void getLogger().info(msg, ctx);
}
function logWarning(msg: string, ctx?: Record<string, unknown>): void {
  void getLogger().warning(msg, ctx);
}
function logError(msg: string, ctx?: Record<string, unknown>): void {
  void getLogger().error(msg, ctx);
}

export class ExecutorError extends Error {}

export class SSHConnectionError extends ExecutorError {}

export class SCPTransferError extends ExecutorError {}

export class CommandExecutionError extends ExecutorError {}

// Marks timeout/wire errors that must escape sshOnce without re-wrapping.
const PASS_THROUGH = Symbol('ssh.passThrough');

function markPassThrough(err: CommandExecutionError): CommandExecutionError {
  (err as unknown as Record<symbol, boolean>)[PASS_THROUGH] = true;
  return err;
}

function isPassThrough(err: unknown): boolean {
  return err instanceof CommandExecutionError && (err as unknown as Record<symbol, boolean>)[PASS_THROUGH] === true;
}

export interface ExecutorOverrides {
  username?: string;
  password?: string;
  port?: number;
  keyPath?: string;
  timeout?: number;
  commandTimeout?: number;
  transferTimeout?: number;
  strictHostKeyChecking?: boolean;
  knownHostsPath?: string;
}

export interface EffectiveSshConfig {
  username: string;
  password: string | null;
  port: number;
  keyPath: string;
  sshConfigPath: string;
  connectionTimeout: number;
  commandTimeout: number;
  transferTimeout: number;
  strictHostKeyChecking: boolean;
  knownHostsPath: string;
}

export interface SshCommandOptions {
  chroot?: string;
  envVars?: Record<string, string>;
  chdir?: string;
  silent?: boolean;
  check?: boolean;
  sensitive?: boolean;
  join?: boolean;
  allowExitStatuses?: number[];
  timeout?: number;
}

export interface ScpOptions {
  sourcePath?: string;
  destPath?: string;
  toRemote?: boolean;
  fileContents?: string;
  timeout?: number;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SshConfigHostOverrides {
  hostname?: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitLines(value: string): string[] {
  if (value === '') return [];
  // eslint-disable-next-line no-control-regex -- deliberate: splitting on Unicode line terminators including \x1c-\x1e
  return value.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
}

const WIDE_WS_CHARS =
  '\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WIDE_STRIP_RE = new RegExp(`^[${WIDE_WS_CHARS}]+|[${WIDE_WS_CHARS}]+$`, 'g');
function strip(value: string): string {
  return value.replace(WIDE_STRIP_RE, '');
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SCP_PATH_ALLOWED_RE = /^[A-Za-z0-9_./ -]*$/;

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function assertSafeScpPath(path: string, label: string): void {
  if (!SCP_PATH_ALLOWED_RE.test(path)) {
    throw new SCPTransferError(`Invalid ${label}: contains disallowed characters`);
  }
}

async function readHostOverrides(sshConfigPath: string, targetHost: string): Promise<SshConfigHostOverrides> {
  if (!sshConfigPath) return {};
  if (!(await fileExists(sshConfigPath))) return {};

  let raw: string;
  try {
    raw = await readFile(sshConfigPath, 'utf-8');
  } catch {
    return {};
  }

  const parsed = SSHConfigParser.parse(raw);
  const computed = parsed.compute(targetHost) as Record<string, string | string[]>;
  const overrides: SshConfigHostOverrides = {};

  const hostname = computed.HostName ?? computed.Hostname;
  if (typeof hostname === 'string' && hostname) overrides.hostname = hostname;

  return overrides;
}

function knownHostsHostMatches(hostField: string, host: string, port: number): boolean {
  if (hostField.startsWith('|')) return false;
  for (const pattern of hostField.split(',')) {
    if (!pattern) continue;
    const bracketedWithPort = pattern.match(/^\[([^\]]+)\]:(\d+)$/);
    if (bracketedWithPort) {
      if (bracketedWithPort[1] === host && Number.parseInt(bracketedWithPort[2] ?? '', 10) === port) return true;
      continue;
    }
    const bracketedOnly = pattern.match(/^\[([^\]]+)\]$/);
    if (bracketedOnly) {
      if (bracketedOnly[1] === host && port === 22) return true;
      continue;
    }
    if (pattern === host && port === 22) return true;
  }
  return false;
}

async function loadKnownHostKeys(knownHostsPath: string, host: string, port: number): Promise<Buffer[]> {
  if (!knownHostsPath || !(await fileExists(knownHostsPath))) return [];

  let raw: string;
  try {
    raw = await readFile(knownHostsPath, 'utf-8');
  } catch {
    return [];
  }

  const keys: Buffer[] = [];
  for (const line of splitLines(raw)) {
    const trimmed = strip(line);
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 3) continue;
    const [hostField, , keyBase64] = fields;
    if (!knownHostsHostMatches(hostField ?? '', host, port)) continue;
    const blob = Buffer.from(keyBase64 ?? '', 'base64');
    if (blob.length > 0) keys.push(blob);
  }
  return keys;
}

function isTrustedHostKey(presented: Buffer, trusted: Buffer[]): boolean {
  return trusted.some((key) => key.length === presented.length && timingSafeEqual(key, presented));
}

export class Executor {
  readonly targetIp: string;
  readonly jobId: string;
  readonly sshConfig: SSHConfig;
  readonly effectiveConfig: EffectiveSshConfig;
  private conn: Client | null = null;

  constructor(targetIp: string, jobId: string, sshConfig?: SSHConfig, overrides: ExecutorOverrides = {}) {
    this.sshConfig = sshConfig ?? getSshConfig();
    this.targetIp = targetIp;
    this.jobId = jobId;
    this.effectiveConfig = this.buildEffectiveConfig(overrides);
  }

  private buildEffectiveConfig(overrides: ExecutorOverrides): EffectiveSshConfig {
    return {
      username: overrides.username ?? this.sshConfig.defaultUsername,
      password: overrides.password ?? null,
      port: overrides.port ?? this.sshConfig.defaultPort,
      keyPath: overrides.keyPath ?? this.sshConfig.defaultKeyPath,
      sshConfigPath: this.sshConfig.sshConfigPath,
      connectionTimeout: overrides.timeout ?? this.sshConfig.defaultTimeout,
      commandTimeout: overrides.commandTimeout ?? this.sshConfig.commandTimeout,
      transferTimeout: overrides.transferTimeout ?? this.sshConfig.scpTimeout,
      strictHostKeyChecking: overrides.strictHostKeyChecking ?? this.sshConfig.strictHostKeyChecking,
      knownHostsPath: overrides.knownHostsPath ?? this.sshConfig.knownHostsPath,
    };
  }

  async connect(): Promise<void> {
    if (this.conn) {
      return;
    }

    logInfo(`Connecting to ${this.targetIp}`, { jobId: this.jobId, appClassName: APP_CLASS });

    const config = this.effectiveConfig;

    const hostOverrides = await readHostOverrides(config.sshConfigPath, this.targetIp);

    const connectConfig: ConnectConfig = {
      host: hostOverrides.hostname ?? this.targetIp,
      port: config.port,
      username: config.username,
      readyTimeout: config.connectionTimeout * 1000,
    };

    let effectiveKeyPath = '';
    if (config.keyPath && (await fileExists(config.keyPath))) {
      effectiveKeyPath = config.keyPath;
    }

    if (effectiveKeyPath) {
      let privateKeyRaw: string;
      try {
        privateKeyRaw = await readFile(effectiveKeyPath, 'utf-8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Failed to import SSH key: ${message}`, { jobId: this.jobId, appClassName: APP_CLASS });
        throw new SSHConnectionError(`SSH key import failed: ${message}`);
      }

      const passphrase = config.password ?? undefined;
      const parsed = ssh2Utils.parseKey(privateKeyRaw, passphrase);
      if (parsed instanceof Error) {
        logError(`Failed to import SSH key: ${parsed.message}`, { jobId: this.jobId, appClassName: APP_CLASS });
        throw new SSHConnectionError(`SSH key import failed: ${parsed.message}`);
      }

      connectConfig.privateKey = privateKeyRaw;
      if (config.password !== null) {
        connectConfig.passphrase = config.password;
      }
    } else {
      connectConfig.password = config.password ?? undefined;
    }

    if (config.strictHostKeyChecking) {
      const verifyHost = connectConfig.host ?? this.targetIp;
      const trustedKeys = await loadKnownHostKeys(config.knownHostsPath, verifyHost, config.port);
      if (trustedKeys.length === 0) {
        const reason = config.knownHostsPath
          ? `no usable known_hosts entry matched in ${config.knownHostsPath} ` +
            `(hashed |1|... and wildcard entries are not supported — provide a plain or [host]:port entry)`
          : `SSH_KNOWN_HOSTS_PATH is empty (provide a known_hosts file, or use the env-gated ` +
            `SSH_STRICT_HOST_KEY_CHECKING=false opt-out in local/dev/sim)`;
        logWarning(
          `Strict host-key checking is on but ${verifyHost}:${config.port} has no trusted key; ` +
            `the connection will be rejected: ${reason}`,
          { jobId: this.jobId, appClassName: APP_CLASS },
        );
      }
      connectConfig.hostVerifier = (key: Buffer): boolean => isTrustedHostKey(key, trustedKeys);
    }

    const client = new Client();
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          client.removeListener('ready', onReady);
          reject(err);
        };
        const onReady = (): void => {
          client.removeListener('error', onError);
          resolve();
        };
        client.once('error', onError);
        client.once('ready', onReady);
        client.connect(connectConfig);
      });
    } catch (err) {
      if (err instanceof Error) {
        logError(`SSH connection failed: ${err.message}`, { jobId: this.jobId, appClassName: APP_CLASS });
        throw new SSHConnectionError(`SSH connection failed: ${err.message}`);
      }
      const typeName =
        err === null ? 'null' : ((err as { constructor?: { name?: string } })?.constructor?.name ?? typeof err);
      logError(`Unexpected connection error: ${typeName}: ${String(err)}`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      throw new SSHConnectionError(`Unexpected connection error: ${typeName}: ${String(err)}`);
    }

    this.conn = client;
    logInfo(`Successfully connected to ${this.targetIp}`, { jobId: this.jobId, appClassName: APP_CLASS });
  }

  async disconnect(): Promise<void> {
    if (this.conn) {
      const conn = this.conn;
      await new Promise<void>((resolve) => {
        conn.once('close', () => resolve());
        conn.end();
      });
      this.conn = null;
      logInfo(`Disconnected from ${this.targetIp}`, { jobId: this.jobId, appClassName: APP_CLASS });
    }
  }

  async ssh(command: string, options: SshCommandOptions = {}): Promise<string | string[]> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SSH_RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.sshOnce(command, options);
      } catch (err) {
        if (!(err instanceof CommandExecutionError)) {
          throw err;
        }
        lastError = err;
        if (attempt < SSH_RETRY_ATTEMPTS - 1) {
          const delaySeconds = SSH_RETRY_DELAYS_SECONDS[Math.min(attempt, SSH_RETRY_DELAYS_SECONDS.length - 1)] ?? 16;
          await sleep(delaySeconds * 1000);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new CommandExecutionError(String(lastError));
  }

  private async sshOnce(command: string, options: SshCommandOptions): Promise<string | string[]> {
    const allowExitStatuses = options.allowExitStatuses ?? [0];
    const silent = options.silent ?? false;
    const check = options.check ?? true;
    const sensitive = options.sensitive ?? false;
    const join = options.join ?? true;
    const timeout = options.timeout ?? this.effectiveConfig.commandTimeout;

    try {
      if (!this.conn) {
        await this.connect();
      }

      const fullCommand = this.buildCommand(command, options.chroot, options.envVars, options.chdir);

      if (!silent) {
        const logCommand = sensitive ? 'SENSITIVE CONTENT REDACTED' : fullCommand;
        logDebug(`Executing SSH command: ${logCommand}`, { jobId: this.jobId, appClassName: APP_CLASS });
      }

      const result = await this.execWithTimeout(fullCommand, timeout);

      const stdout = strip(result.stdout);
      const stderr = strip(result.stderr);
      const exitCode = result.exitCode;

      if (stdout && !silent) {
        const logStdout = sensitive ? 'SENSITIVE CONTENT REDACTED' : stdout;
        logDebug(`SSH command output: ${logStdout}`, { jobId: this.jobId, appClassName: APP_CLASS });
      }

      if (stderr && !silent) {
        const logStderr = sensitive ? 'SENSITIVE CONTENT REDACTED' : stderr;
        logWarning(`SSH command stderr: ${logStderr}`, { jobId: this.jobId, appClassName: APP_CLASS });
      }

      if (!allowExitStatuses.includes(exitCode) && check) {
        const errorMsg = `Command '${command}' failed with exit status ${exitCode}`;
        logError(errorMsg, { jobId: this.jobId, appClassName: APP_CLASS });
        throw new CommandExecutionError(errorMsg);
      }

      return join ? stdout : splitLines(stdout);
    } catch (err) {
      if (isPassThrough(err)) {
        throw err;
      }
      if (err instanceof Error) {
        if (!(err instanceof ExecutorError)) {
          logError(`SSH command execution failed: ${err.message}`, { jobId: this.jobId, appClassName: APP_CLASS });
          throw new CommandExecutionError(`SSH execution failed: ${err.message}`);
        }
        logError(`Unexpected SSH error: ${err.message}`, { jobId: this.jobId, appClassName: APP_CLASS });
        throw new CommandExecutionError(`Unexpected SSH error: ${err.message}`);
      }
      logError(`Unexpected SSH error: ${String(err)}`, { jobId: this.jobId, appClassName: APP_CLASS });
      throw new CommandExecutionError(`Unexpected SSH error: ${String(err)}`);
    }
  }

  private execWithTimeout(fullCommand: string, timeoutSeconds: number): Promise<ExecResult> {
    const conn = this.conn;
    if (!conn) {
      return Promise.reject(new CommandExecutionError('SSH execution failed: not connected'));
    }

    return new Promise<ExecResult>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        const errorMsg = `SSH command timed out after ${timeoutSeconds} seconds`;
        logError(errorMsg, { jobId: this.jobId, appClassName: APP_CLASS });
        reject(markPassThrough(new CommandExecutionError(errorMsg)));
      }, timeoutSeconds * 1000);

      conn.exec(fullCommand, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            reject(err);
          }
          return;
        }

        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        stream.on('data', (chunk: Buffer) => {
          stdoutChunks.push(chunk.toString());
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk.toString());
        });
        stream.on('close', (code: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve({
            stdout: stdoutChunks.join(''),
            stderr: stderrChunks.join(''),
            exitCode: typeof code === 'number' ? code : -1,
          });
        });
        stream.on('error', (streamErr: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          reject(streamErr);
        });
      });
    });
  }

  buildCommand(command: string, chroot?: string, envVars?: Record<string, string>, chdir?: string): string {
    let fullCommand = command;

    if (envVars && Object.keys(envVars).length > 0) {
      const envString = Object.entries(envVars)
        .map(([key, value]) => {
          if (!ENV_VAR_NAME_RE.test(key)) {
            throw new CommandExecutionError(`Invalid environment variable name: ${key}`);
          }
          return `${key}=${shellQuote(value)}`;
        })
        .join(' ');
      fullCommand = `${envString} ${command}`;
    }

    if (chroot) {
      fullCommand = `chroot ${shellQuote(chroot)} /usr/bin/bash -c ${shellQuote(fullCommand)}`;
    }

    if (chdir) {
      fullCommand = `/usr/bin/bash -c ${shellQuote('cd ' + shellQuote(chdir) + ' && ' + fullCommand)}`;
    }

    return fullCommand;
  }

  async scp(options: ScpOptions = {}): Promise<void> {
    const toRemote = options.toRemote ?? true;
    const timeout = options.timeout ?? this.effectiveConfig.transferTimeout;
    let sourcePath = options.sourcePath;
    const destPath = options.destPath;

    let tempFile: string | null = null;

    if (toRemote) {
      if (destPath !== undefined) assertSafeScpPath(destPath, 'destPath');
    } else {
      if (sourcePath !== undefined) assertSafeScpPath(sourcePath, 'sourcePath');
    }

    try {
      if (options.fileContents) {
        tempFile = `/tmp/scp_temp_${randomUUID()}.tmp`;
        await writeFile(tempFile, options.fileContents);
        sourcePath = tempFile;
        logDebug(`Created temporary file: ${tempFile}`, { jobId: this.jobId, appClassName: APP_CLASS });
      }

      if (!this.conn) {
        await this.connect();
      }

      if (toRemote) {
        logDebug(`SCP: ${sourcePath} -> ${this.targetIp}:${destPath}`, { jobId: this.jobId, appClassName: APP_CLASS });
        await this.scpUploadWithTimeout(sourcePath ?? '', destPath ?? '', timeout);
      } else {
        logDebug(`SCP: ${this.targetIp}:${sourcePath} -> ${destPath}`, { jobId: this.jobId, appClassName: APP_CLASS });
        await this.scpDownloadWithTimeout(sourcePath ?? '', destPath ?? '', timeout);
      }

      logDebug('SCP transfer completed successfully', { jobId: this.jobId, appClassName: APP_CLASS });
    } catch (err) {
      if (err instanceof SCPTransferError) {
        throw err;
      }
      if (err instanceof ExecutorError) {
        const errorMsg = `Unexpected SCP error: ${err.message}`;
        logError(errorMsg, { jobId: this.jobId, appClassName: APP_CLASS });
        throw new SCPTransferError(errorMsg);
      }
      if (err instanceof Error) {
        const errorMsg = `SCP transfer failed: ${err.message}`;
        logError(errorMsg, { jobId: this.jobId, appClassName: APP_CLASS });
        throw new SCPTransferError(errorMsg);
      }
      const errorMsg = `Unexpected SCP error: ${String(err)}`;
      logError(errorMsg, { jobId: this.jobId, appClassName: APP_CLASS });
      throw new SCPTransferError(errorMsg);
    } finally {
      if (tempFile !== null && (await fileExists(tempFile))) {
        try {
          await unlink(tempFile);
        } catch (err) {
          logWarning(`Failed to remove temp file ${tempFile}: ${err instanceof Error ? err.message : String(err)}`, {
            jobId: this.jobId,
            appClassName: APP_CLASS,
          });
        }
      }
    }
  }

  private scpUploadWithTimeout(localPath: string, remotePath: string, timeoutSeconds: number): Promise<void> {
    const conn = this.conn;
    if (!conn) {
      return Promise.reject(new SCPTransferError('SCP transfer failed: not connected'));
    }

    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        const errorMsg = `SCP transfer timed out after ${timeoutSeconds} seconds`;
        logError(errorMsg, { jobId: this.jobId, appClassName: APP_CLASS });
        reject(new SCPTransferError(errorMsg));
      }, timeoutSeconds * 1000);

      const settle = (err: Error | null): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      (async () => {
        let payload: Buffer;
        try {
          payload = await readFile(localPath);
        } catch (err) {
          settle(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const name = basename(localPath) || 'file';
        const mode = '0644';

        const remoteShell = `scp -t ${shellQuote(remotePath)}`;
        conn.exec(remoteShell, (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            settle(err);
            return;
          }

          const acks: number[] = [];
          let state: 'await-ready' | 'await-header-ack' | 'await-data-ack' | 'done' = 'await-ready';

          stream.on('data', (chunk: Buffer) => {
            for (const byte of chunk) acks.push(byte);
            while (acks.length > 0 && state !== 'done') {
              const code = acks.shift()!;
              if (code !== 0) {
                settle(new SCPTransferError(`SCP remote ack=${code}`));
                return;
              }
              if (state === 'await-ready') {
                stream.write(`C${mode} ${payload.length} ${name}\n`);
                state = 'await-header-ack';
              } else if (state === 'await-header-ack') {
                stream.write(payload);
                stream.write(Buffer.from([0]));
                state = 'await-data-ack';
              } else if (state === 'await-data-ack') {
                state = 'done';
                stream.end();
              }
            }
          });

          stream.stderr.on('data', () => undefined);
          stream.on('close', () => {
            if (state === 'done') settle(null);
            else settle(new SCPTransferError('SCP upload closed before completion'));
          });
          stream.on('error', (streamErr: Error) => settle(streamErr));
        });
      })().catch((err) => settle(err instanceof Error ? err : new Error(String(err))));
    });
  }

  private scpDownloadWithTimeout(remotePath: string, localPath: string, timeoutSeconds: number): Promise<void> {
    const conn = this.conn;
    if (!conn) {
      return Promise.reject(new SCPTransferError('SCP transfer failed: not connected'));
    }

    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        const errorMsg = `SCP transfer timed out after ${timeoutSeconds} seconds`;
        logError(errorMsg, { jobId: this.jobId, appClassName: APP_CLASS });
        reject(new SCPTransferError(errorMsg));
      }, timeoutSeconds * 1000);

      const settle = (err: Error | null): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      const remoteShell = `scp -f ${shellQuote(remotePath)}`;
      conn.exec(remoteShell, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          settle(err);
          return;
        }

        const buf: number[] = [];
        let state: 'await-header' | 'await-data' | 'await-trailing' | 'done' = 'await-header';
        let expectedSize = 0;
        let received: Buffer[] = [];
        let receivedBytes = 0;

        stream.write(Buffer.from([0]));

        stream.on('data', (chunk: Buffer) => {
          for (const byte of chunk) buf.push(byte);

          while (buf.length > 0 && state !== 'done') {
            if (state === 'await-header') {
              const newlineIdx = buf.indexOf(0x0a);
              if (newlineIdx === -1) return;
              const headerBytes = buf.splice(0, newlineIdx + 1);
              const header = Buffer.from(headerBytes.slice(0, -1)).toString('utf-8');
              if (!header.startsWith('C')) {
                settle(new SCPTransferError(`SCP unexpected header: ${header}`));
                return;
              }
              const parts = header.slice(1).split(' ');
              if (parts.length < 2) {
                settle(new SCPTransferError(`SCP malformed header: ${header}`));
                return;
              }
              expectedSize = Number.parseInt(parts[1] ?? '0', 10);
              if (!Number.isFinite(expectedSize) || expectedSize < 0) {
                settle(new SCPTransferError(`SCP invalid size in header: ${header}`));
                return;
              }
              stream.write(Buffer.from([0]));
              state = 'await-data';
            } else if (state === 'await-data') {
              const remaining = expectedSize - receivedBytes;
              if (remaining <= 0) {
                state = 'await-trailing';
                continue;
              }
              const take = Math.min(remaining, buf.length);
              received.push(Buffer.from(buf.splice(0, take)));
              receivedBytes += take;
              if (receivedBytes === expectedSize) state = 'await-trailing';
              else return;
            } else if (state === 'await-trailing') {
              const code = buf.shift()!;
              if (code !== 0) {
                settle(new SCPTransferError(`SCP unexpected trailing byte: ${code}`));
                return;
              }
              stream.write(Buffer.from([0]));
              void (async () => {
                try {
                  await writeFile(localPath, Buffer.concat(received));
                  state = 'done';
                  stream.end();
                  settle(null);
                } catch (writeErr) {
                  settle(writeErr instanceof Error ? writeErr : new Error(String(writeErr)));
                }
              })();
              received = [];
              return;
            }
          }
        });

        stream.stderr.on('data', () => undefined);
        stream.on('close', () => {
          if (state !== 'done') settle(new SCPTransferError('SCP download closed before completion'));
        });
        stream.on('error', (streamErr: Error) => settle(streamErr));
      });
    });
  }
}

export async function createExecutor(
  targetSshIpAddress: string,
  jobId: string,
  overrides: ExecutorOverrides = {},
): Promise<Executor> {
  return new Executor(targetSshIpAddress, jobId, undefined, overrides);
}
