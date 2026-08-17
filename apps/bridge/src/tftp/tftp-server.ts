import { Logger } from '@nestjs/common';
import { createSocket, Socket as DgramSocket, RemoteInfo } from 'node:dgram';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  DEF_TFTP_PORT,
  DEF_TIMEOUT_RETRIES,
  SOCK_TIMEOUT,
  TftpException,
  TftpTimeout,
  TftpTimeoutExpectACK,
} from './tftp-shared.js';

const log = new Logger('tftpy.TftpServer');

export interface TftpSessionMetrics {
  readonly bytes: number;
  readonly resentBytes: number;
  readonly dupcount: number;
  readonly duration: number;
  readonly kbps: number;
}

export interface TftpSessionState {
  resendLast(): void;
}

export interface TftpSession {
  readonly sock: DgramSocket;
  readonly host: string;
  state: TftpSessionState | null;
  timeoutExpectACK: boolean;
  retryCount: number;
  readonly retries: number;
  readonly metrics: TftpSessionMetrics;
  start(buffer: Buffer): void;
  deliverFromRemote(buffer: Buffer, rinfo: RemoteInfo): void;
  cycle(): void;
  checkTimeout(now: number): void;
  end(): void;
}

export interface TftpSessionFactoryArgs {
  readonly host: string;
  readonly port: number;
  readonly timeout: number;
  readonly root: string;
  readonly dynFileFunc: DynFileFunc | null;
  readonly retries: number;
}

export type TftpSessionFactory = (args: TftpSessionFactoryArgs) => TftpSession;

export type DynFileFunc = (filename: string) => unknown;

export interface TftpServerOptions {
  tftproot?: string;
  dynFileFunc?: DynFileFunc | null;
  flock?: boolean;
  sessionFactory: TftpSessionFactory;
}

export interface TftpListenOptions {
  listenip?: string;
  listenport?: number;
  timeout?: number;
  retries?: number;
}

interface ReadyPacket {
  socket: DgramSocket;
  buffer: Buffer;
  rinfo: RemoteInfo;
}

interface QueuedPackets {
  main: ReadyPacket[];
  sessions: Map<DgramSocket, ReadyPacket[]>;
}

export class TftpServer {
  listenip: string | null = null;
  listenport: number | null = null;
  sock: DgramSocket | null = null;
  readonly root: string;
  readonly dynFileFunc: DynFileFunc | null;
  readonly sessions: Map<string, TftpSession> = new Map();
  isRunning = false;

  shutdownGracefully = false;
  shutdownImmediately = false;

  private readonly sessionFactory: TftpSessionFactory;
  private readonly queued: QueuedPackets = { main: [], sessions: new Map() };
  private wakeWaiter: (() => void) | null = null;
  private fatalSocketError: Error | null = null;

  constructor(options: TftpServerOptions) {
    const tftproot = options.tftproot ?? '/tftpboot';
    this.root = path.resolve(tftproot);
    this.dynFileFunc = options.dynFileFunc ?? null;
    this.sessionFactory = options.sessionFactory;

    if (this.dynFileFunc && typeof this.dynFileFunc !== 'function') {
      throw new TftpException('dyn_file_func supplied, but it is not callable.');
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.root);
    } catch {
      throw new TftpException('The tftproot does not exist.');
    }
    log.debug(`tftproot ${this.root} does exist`);
    if (!stat.isDirectory()) {
      throw new TftpException('The tftproot must be a directory.');
    }
    log.debug(`tftproot ${this.root} is a directory`);
    try {
      fs.accessSync(this.root, fs.constants.R_OK);
      log.debug(`tftproot ${this.root} is readable`);
    } catch {
      throw new TftpException('The tftproot must be readable');
    }
    try {
      fs.accessSync(this.root, fs.constants.W_OK);
      log.debug(`tftproot ${this.root} is writable`);
    } catch {
      log.warn(`The tftproot ${this.root} is not writable`);
    }
  }

  async listen(opts: TftpListenOptions = {}): Promise<void> {
    const listenipRaw = opts.listenip ?? '';
    const listenport = opts.listenport ?? DEF_TFTP_PORT;
    const timeout = opts.timeout ?? SOCK_TIMEOUT;
    const retries = opts.retries ?? DEF_TIMEOUT_RETRIES;

    const listenip = listenipRaw ? listenipRaw : '0.0.0.0';
    log.log(`Server requested on ip ${listenip}, port ${listenport}`);

    this.sock = createSocket({ type: 'udp4', reuseAddr: false });
    this.attachMainSocketHandlers(this.sock);

    await new Promise<void>((resolve, reject) => {
      const sock = this.sock!;
      const onError = (err: Error): void => {
        sock.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        sock.removeListener('error', onError);
        resolve();
      };
      sock.once('error', onError);
      sock.once('listening', onListening);
      sock.bind(listenport, listenip);
    });

    const bound = this.sock.address();
    this.listenport = bound.port;
    this.listenip = listenip;

    this.isRunning = true;

    log.log('Starting receive loop...');
    try {
      await this.runLoop(timeout, retries);
    } finally {
      this.isRunning = false;
      log.debug('server returning from while loop');
      this.shutdownGracefully = false;
      this.shutdownImmediately = false;
    }
  }

  stop(now = false): void {
    if (now) {
      this.shutdownImmediately = true;
    } else {
      this.shutdownGracefully = true;
    }
  }

  private attachMainSocketHandlers(sock: DgramSocket): void {
    sock.on('message', (buffer, rinfo) => {
      this.queued.main.push({ socket: sock, buffer, rinfo });
      this.wake();
    });
    sock.on('error', (err) => {
      this.fatalSocketError = err;
      this.wake();
    });
  }

  private attachSessionSocketHandlers(sock: DgramSocket): void {
    const queue: ReadyPacket[] = [];
    this.queued.sessions.set(sock, queue);
    sock.on('message', (buffer, rinfo) => {
      queue.push({ socket: sock, buffer, rinfo });
      this.wake();
    });
  }

  private detachSessionSocket(sock: DgramSocket): void {
    this.queued.sessions.delete(sock);
  }

  private wake(): void {
    const waiter = this.wakeWaiter;
    if (waiter) {
      this.wakeWaiter = null;
      waiter();
    }
  }

  private async waitForIO(timeoutMs: number): Promise<void> {
    if (this.hasReadyInput()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.wakeWaiter === wakeup) this.wakeWaiter = null;
        resolve();
      }, timeoutMs);
      const wakeup = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.wakeWaiter = wakeup;
    });
  }

  private hasReadyInput(): boolean {
    if (this.queued.main.length > 0) return true;
    for (const list of this.queued.sessions.values()) {
      if (list.length > 0) return true;
    }
    return false;
  }

  private drainReady(): ReadyPacket[] {
    const ready: ReadyPacket[] = [];
    if (this.queued.main.length > 0) {
      ready.push(...this.queued.main);
      this.queued.main.length = 0;
    }
    for (const list of this.queued.sessions.values()) {
      if (list.length > 0) {
        ready.push(...list);
        list.length = 0;
      }
    }
    return ready;
  }

  private async runLoop(timeout: number, retries: number): Promise<void> {
    const timeoutMs = Math.round(timeout * 1000);
    while (true) {
      if (this.shutdownImmediately) {
        log.log(`Shutting down now. Session count: ${this.sessions.size}`);
        this.closeMainSocket();
        for (const session of this.sessions.values()) {
          log.warn(`Forcefully closed session with ${session.host}`);
          session.end();
        }
        this.sessions.clear();
        break;
      }

      if (this.shutdownGracefully) {
        if (this.sessions.size === 0) {
          log.log('In graceful shutdown mode and all sessions complete.');
          this.closeMainSocket();
          break;
        }
      }

      await this.waitForIO(timeoutMs);

      if (this.fatalSocketError !== null) {
        const err = this.fatalSocketError;
        this.fatalSocketError = null;
        throw err;
      }

      const deletionList: string[] = [];
      const ready = this.drainReady();

      for (const packet of ready) {
        if (packet.socket === this.sock) {
          log.debug('Data ready on our main socket');
          const { buffer, rinfo } = packet;
          log.debug(`Read ${buffer.length} bytes`);

          if (this.shutdownGracefully) {
            log.warn('Discarding data on main port, in graceful shutdown mode');
            continue;
          }

          const key = `${rinfo.address}:${rinfo.port}`;

          if (!this.sessions.has(key)) {
            log.debug(`Creating new server context for session key = ${key}`);
            const session = this.sessionFactory({
              host: rinfo.address,
              port: rinfo.port,
              timeout,
              root: this.root,
              dynFileFunc: this.dynFileFunc,
              retries,
            });
            this.sessions.set(key, session);
            this.attachSessionSocketHandlers(session.sock);
            try {
              session.start(buffer);
            } catch (err) {
              if (err instanceof TftpTimeoutExpectACK) {
                session.timeoutExpectACK = true;
              } else if (err instanceof TftpException) {
                deletionList.push(key);
                log.error(`Fatal exception thrown from session ${key}: ${err.message}`);
              } else {
                throw err;
              }
            }
          } else {
            log.warn('received traffic on main socket for existing session??');
          }
          log.log('Currently handling these sessions:');
          for (const [, session] of this.sessions) {
            log.log(`    ${String(session)}`);
          }
        } else {
          let matched = false;
          for (const [key, session] of this.sessions) {
            if (packet.socket === session.sock) {
              session.timeoutExpectACK = false;
              try {
                session.deliverFromRemote(packet.buffer, packet.rinfo);
                session.cycle();
                if (session.state === null) {
                  log.log('Successful transfer.');
                  deletionList.push(key);
                }
              } catch (err) {
                if (err instanceof TftpTimeoutExpectACK) {
                  session.timeoutExpectACK = true;
                } else if (err instanceof TftpException) {
                  deletionList.push(key);
                  log.warn(`Session ${key} ended on exception: ${err.message}`);
                } else {
                  throw err;
                }
              }
              matched = true;
              break;
            }
          }
          if (!matched) {
            log.error("Can't find the owner for this packet. Discarding.");
          }
        }
      }

      const now = Date.now() / 1000;
      for (const [key, session] of this.sessions) {
        try {
          session.checkTimeout(now);
        } catch (err) {
          if (err instanceof TftpTimeout) {
            session.retryCount += 1;
            if (session.retryCount >= session.retries) {
              log.error(err.message);
              log.debug(`hit max retries on ${String(session)}, giving up`);
              deletionList.push(key);
            } else {
              log.warn(err.message);
              log.debug(`resending on session ${String(session)}`);
              (session.state as TftpSessionState).resendLast();
            }
          } else {
            throw err;
          }
        }
      }

      for (const key of deletionList) {
        log.log('');
        log.log(`Session ${key} complete`);
        const session = this.sessions.get(key);
        if (session !== undefined) {
          log.debug('Gathering up metrics from session before deleting');
          session.end();
          const metrics = session.metrics;
          if (metrics.duration === 0) {
            log.log('Duration too short, rate undetermined');
          } else {
            log.log(`Transferred ${metrics.bytes} bytes in ${metrics.duration.toFixed(2)} seconds`);
            log.log(`Average rate: ${metrics.kbps.toFixed(2)} kbps`);
          }
          log.log(`${metrics.resentBytes.toFixed(2)} bytes in resent data`);
          log.log(`${metrics.dupcount} duplicate packets`);
          log.debug(`Deleting session ${key}`);
          this.detachSessionSocket(session.sock);
          this.sessions.delete(key);
          log.debug('Session list is now [...]');
        } else {
          log.warn(`Strange, session ${key} is not on the deletion list`);
        }
      }
    }
  }

  private closeMainSocket(): void {
    if (this.sock !== null) {
      try {
        this.sock.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.debug(`TFTP main socket close failed: ${message}`);
      }
      this.sock = null;
    }
  }
}
