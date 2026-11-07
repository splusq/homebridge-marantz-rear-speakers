/**
 * A fake Marantz/Denon receiver on the telnet protocol, for tests and local play.
 *
 * Modelled on what a Cinema 30 sends: it answers queries, and broadcasts a status line
 * to every connected client whenever its state changes, whoever changed it.
 *
 *   npm run mock            # listens on 127.0.0.1:2323; type spotify / tv / standby / state
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export type Power = 'ON' | 'STANDBY' | 'BOOTING';

export interface MockState {
  power: Power;
  input: string;
  preset: number;
  soundMode: string;
}

export class MockAvr {
  state: MockState = { power: 'STANDBY', input: 'SAT/CBL', preset: 1, soundMode: 'AURO2DSURR' };
  /** Every command received, in order. */
  readonly received: string[] = [];
  /** After waking, ignore commands for this long (a real unit is briefly deaf while it powers up). */
  bootMs = 0;
  /** How long a speaker preset change takes before the receiver confirms it. */
  presetDelayMs = 150;
  /** Sound modes the receiver refuses (it re-announces the current mode instead). */
  readonly refusedSoundModes = new Set<string>();
  /** Stop answering anything, to simulate a half-open connection. */
  silent = false;
  port = 0;

  readonly #server = net.createServer((socket) => this.#accept(socket));
  readonly #clients = new Set<net.Socket>();
  #bootUntil = 0;

  async start(port = 0): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(port, '127.0.0.1', resolve));
    this.port = (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Commands that change something (not queries). */
  get sets(): string[] {
    return this.received.filter((command) => !command.endsWith('?'));
  }

  dropClients(): void {
    for (const client of this.#clients) {
      client.destroy();
    }
  }

  // --- things that happen to the receiver from outside -------------------------------

  /** Spotify Connect picks the receiver: it wakes on HEOS Music in plain Stereo. */
  spotifyConnect(): void {
    this.#wake();
    this.state.input = 'NET';
    this.state.soundMode = 'STEREO';
    this.#broadcast('SINET', 'MSSTEREO');
  }

  /** The TV wakes the receiver over HDMI-CEC, or someone picks the TV input. */
  tv(): void {
    this.#wake();
    this.state.input = 'SAT/CBL';
    this.state.soundMode = 'AURO2DSURR';
    this.#broadcast('SISAT/CBL', 'MSAURO2DSURR');
  }

  standby(): void {
    this.state.power = 'STANDBY';
    this.#broadcast('ZMOFF', 'PWSTANDBY');
  }

  #wake(): void {
    if (this.state.power === 'STANDBY') {
      this.state.power = this.bootMs ? 'BOOTING' : 'ON';
      this.#bootUntil = Date.now() + this.bootMs;
      this.#broadcast('PWON', 'ZMON');
    }
  }

  // --- protocol ---------------------------------------------------------------------

  #accept(socket: net.Socket): void {
    this.#clients.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\r');
      buffer = lines.pop() ?? '';
      lines.filter(Boolean).forEach((command) => this.#handle(socket, command));
    });
    socket.on('close', () => this.#clients.delete(socket));
    socket.on('error', () => undefined);
  }

  #reply(socket: net.Socket, ...lines: string[]): void {
    if (!this.silent && !socket.destroyed) {
      socket.write(lines.map((line) => `${line}\r`).join(''));
    }
  }

  #broadcast(...lines: string[]): void {
    for (const client of this.#clients) {
      this.#reply(client, ...lines);
    }
  }

  #handle(socket: net.Socket, command: string): void {
    this.received.push(command);
    if (this.silent) {
      return;
    }
    if (this.state.power === 'BOOTING') {
      if (Date.now() < this.#bootUntil) {
        return;
      }
      this.state.power = 'ON';
    }
    const on = this.state.power === 'ON';
    switch (command) {
      case 'ZM?':
        return this.#reply(socket, on ? 'ZMON' : 'ZMOFF', 'SLPOFF');
      case 'SI?':
        return this.#reply(socket, `SI${this.state.input}`, 'SVOFF', 'SSINFAISSIG 12');
      case 'SPPR ?':
        return this.#reply(socket, `SPPR ${this.state.preset}`);
      case 'MS?':
        return this.#reply(socket, 'MSSMART0', `MS${this.state.soundMode}`, 'PSDRC OFF');
    }
    if (!on) {
      return;
    }
    let match: RegExpExecArray | null;
    if ((match = /^SPPR ([12])$/.exec(command))) {
      const preset = Number(match[1]);
      setTimeout(() => {
        this.state.preset = preset;
        this.#broadcast('SSSPCFRO YES', 'SSPAAMOD ZO2', `SPPR ${preset}`, 'MVMAX 96');
      }, this.presetDelayMs);
    } else if ((match = /^MS(.+)$/.exec(command))) {
      if (!this.refusedSoundModes.has(match[1])) {
        this.state.soundMode = match[1];
      }
      this.#broadcast(`MS${this.state.soundMode}`);
    } else if ((match = /^SI(.+)$/.exec(command))) {
      this.state.input = match[1];
      this.#broadcast(command);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const avr = new MockAvr();
  await avr.start(Number(process.env.PORT ?? 2323));
  console.log(`Mock receiver on 127.0.0.1:${avr.port}. Commands: spotify, tv, standby, state, quit`);
  const actions: Record<string, () => void> = {
    spotify: () => avr.spotifyConnect(),
    tv: () => avr.tv(),
    standby: () => avr.standby(),
    state: () => console.log(avr.state, 'received:', avr.received.slice(-10)),
    quit: () => void avr.stop().then(() => process.exit(0)),
  };
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    (actions[line.trim()] ?? (() => console.log('?')))();
  });
}
