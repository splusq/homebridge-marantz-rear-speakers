import { EventEmitter } from 'node:events';
import net from 'node:net';

export interface Logger {
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
  debug(message: string, ...parameters: unknown[]): void;
}

export interface AvrConnectionOptions {
  host: string;
  port?: number;
  /** Gap between commands. The Denon/Marantz protocol asks for at least 50 ms. */
  commandGapMs?: number;
  /** Send a status query after this long without hearing from the receiver. */
  heartbeatMs?: number;
  connectTimeoutMs?: number;
  maxBackoffMs?: number;
}

/**
 * One long-lived connection to the receiver's telnet control port (23).
 *
 * The receiver pushes a status line (CR-terminated) whenever anything changes, whoever
 * changed it, so listening is enough to follow its state. Commands are queued and paced.
 * The connection reconnects with backoff and uses a heartbeat to catch half-open sockets.
 */
export class AvrConnection extends EventEmitter<{ line: [string]; connected: []; disconnected: [] }> {
  readonly #host: string;
  readonly #port: number;
  readonly #gapMs: number;
  readonly #heartbeatMs: number;
  readonly #connectTimeoutMs: number;
  readonly #maxBackoffMs: number;
  readonly #log: Logger;

  #socket: net.Socket | undefined;
  #connected = false;
  #stopped = true;
  #buffer = '';
  #queue: string[] = [];
  #lastWriteAt = 0;
  #lastReceivedAt = 0;
  #backoffMs = 1000;
  #flushTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(options: AvrConnectionOptions, log: Logger) {
    super();
    this.#host = options.host;
    this.#port = options.port ?? 23;
    this.#gapMs = options.commandGapMs ?? 100;
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.#log = log;
  }

  get connected(): boolean {
    return this.#connected;
  }

  start(): void {
    if (!this.#stopped) {
      return;
    }
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#flushTimer);
    clearInterval(this.#heartbeatTimer);
    this.#flushTimer = undefined;
    this.#socket?.destroy();
  }

  /** Queue a command (without the trailing CR). Dropped while disconnected: state is re-read on reconnect. */
  send(command: string): void {
    if (!this.#connected) {
      this.#log.debug('Not connected, dropping %s', command);
      return;
    }
    this.#queue.push(command);
    this.#flush();
  }

  #connect(): void {
    const socket = net.createConnection({ host: this.#host, port: this.#port });
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);

    const connectTimer = setTimeout(() => {
      this.#log.debug('Connecting to %s:%d timed out', this.#host, this.#port);
      socket.destroy();
    }, this.#connectTimeoutMs);

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      this.#connected = true;
      this.#backoffMs = 1000;
      this.#lastReceivedAt = Date.now();
      this.#startHeartbeat();
      this.#log.debug('Connected to %s:%d', this.#host, this.#port);
      this.emit('connected');
    });

    socket.on('data', (chunk: string) => {
      this.#lastReceivedAt = Date.now();
      this.#buffer += chunk;
      const lines = this.#buffer.split('\r');
      this.#buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (line) {
          this.#log.debug('<< %s', line);
          this.emit('line', line);
        }
      }
    });

    socket.on('error', (error) => {
      this.#log.debug('Connection error: %s', error.message);
    });

    socket.on('close', () => {
      clearTimeout(connectTimer);
      if (this.#socket !== socket) {
        return;
      }
      this.#socket = undefined;
      const wasConnected = this.#connected;
      this.#connected = false;
      this.#buffer = '';
      this.#queue = [];
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
      clearInterval(this.#heartbeatTimer);
      if (wasConnected) {
        this.emit('disconnected');
      }
      if (!this.#stopped) {
        this.#log.debug('Reconnecting in %d ms', this.#backoffMs);
        this.#reconnectTimer = setTimeout(() => this.#connect(), this.#backoffMs);
        this.#backoffMs = Math.min(this.#backoffMs * 2, this.#maxBackoffMs);
      }
    });
  }

  #flush(): void {
    if (this.#flushTimer || this.#queue.length === 0 || !this.#connected) {
      return;
    }
    const wait = Math.max(0, this.#lastWriteAt + this.#gapMs - Date.now());
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      const command = this.#queue.shift();
      if (command !== undefined && this.#socket && this.#connected) {
        this.#log.debug('>> %s', command);
        this.#socket.write(`${command}\r`);
        this.#lastWriteAt = Date.now();
      }
      this.#flush();
    }, wait);
  }

  #startHeartbeat(): void {
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = setInterval(() => {
      const silentFor = Date.now() - this.#lastReceivedAt;
      if (silentFor >= this.#heartbeatMs * 2) {
        this.#log.debug('No reply from the receiver for %d ms, reconnecting', silentFor);
        this.#socket?.destroy();
      } else if (silentFor >= this.#heartbeatMs) {
        this.send('ZM?');
      }
    }, Math.max(50, Math.floor(this.#heartbeatMs / 2)));
  }
}
