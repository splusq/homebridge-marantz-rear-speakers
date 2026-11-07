import type { Logger } from './avr.ts';

/** The part of AvrConnection the controller needs, so tests can substitute it. */
export interface AvrLink {
  send(command: string): void;
  on(event: 'line', listener: (line: string) => void): unknown;
  on(event: 'connected' | 'disconnected', listener: () => void): unknown;
}

export interface ControllerOptions {
  /** Inputs that get the rear-speaker preset, as the receiver names them (SI<input>). HEOS Music is "NET". */
  inputs: string[];
  /** Sound mode to hold while the rear preset is active, e.g. "MCH STEREO". Empty leaves it alone. */
  soundMode: string;
  /** Wait for a burst of status lines to settle before acting. */
  settleMs?: number;
  /** Re-send a command the receiver hasn't confirmed after this long (it ignores commands while waking). */
  retryMs?: number;
  /** Stop re-sending the same command after this many tries, until the situation changes. */
  maxAttempts?: number;
}

export interface ReceiverState {
  zone?: 'ON' | 'OFF';
  input?: string;
  preset?: number;
  soundMode?: string;
}

const REAR_PRESET = 2;
const NORMAL_PRESET = 1;
const QUERIES = ['ZM?', 'SI?', 'SPPR ?', 'MS?'];

/**
 * The rule:
 *   main zone on, switch on, input is one of `inputs`  ->  Speaker Preset 2 (+ sound mode)
 *   main zone on, anything else                         ->  Speaker Preset 1
 *   main zone off                                       ->  leave it alone
 * Commands go out only when the receiver differs from that, never power or input commands.
 */
export class PresetController {
  readonly #avr: AvrLink;
  readonly #log: Logger;
  readonly #inputs: Set<string>;
  readonly #soundMode: string;
  readonly #settleMs: number;
  readonly #retryMs: number;
  readonly #maxAttempts: number;

  #enabled: boolean;
  #state: ReceiverState = {};
  #timer: NodeJS.Timeout | undefined;
  #goal: string | undefined;
  #attempts = 0;
  #lastSentAt = 0;

  constructor(avr: AvrLink, options: ControllerOptions, log: Logger, enabled = true) {
    this.#avr = avr;
    this.#log = log;
    this.#inputs = new Set(options.inputs.map((input) => input.trim().toUpperCase()).filter(Boolean));
    this.#soundMode = options.soundMode.trim().toUpperCase();
    this.#settleMs = options.settleMs ?? 300;
    this.#retryMs = options.retryMs ?? 2_500;
    this.#maxAttempts = options.maxAttempts ?? 6;
    this.#enabled = enabled;

    avr.on('connected', () => {
      this.#state = {};
      this.#resetGoal();
      QUERIES.forEach((query) => avr.send(query));
    });
    avr.on('disconnected', () => {
      clearTimeout(this.#timer);
      this.#state = {};
    });
    avr.on('line', (line) => this.#onLine(line));
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get state(): ReceiverState {
    return { ...this.#state };
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) {
      return;
    }
    this.#enabled = enabled;
    this.#resetGoal();
    this.#schedule(0);
  }

  stop(): void {
    clearTimeout(this.#timer);
  }

  #onLine(line: string): void {
    const next = { ...this.#state };
    let match: RegExpExecArray | null;
    if ((match = /^ZM(ON|OFF)$/.exec(line))) {
      next.zone = match[1] as 'ON' | 'OFF';
    } else if (line === 'PWSTANDBY') {
      next.zone = 'OFF';
    } else if ((match = /^SPPR ([12])$/.exec(line))) {
      next.preset = Number(match[1]);
    } else if ((match = /^SI(?!\?)(.+)$/.exec(line))) {
      next.input = match[1];
    } else if ((match = /^MS(?!\?|SMART\d|QUICK\d)(.+)$/.exec(line))) {
      next.soundMode = match[1];
    } else {
      return;
    }
    const changed = (Object.keys(next) as (keyof ReceiverState)[]).some((key) => next[key] !== this.#state[key]);
    this.#state = next;
    if (changed) {
      this.#schedule(this.#settleMs);
    }
  }

  #schedule(delayMs: number): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#evaluate(), delayMs);
  }

  #resetGoal(): void {
    this.#goal = undefined;
    this.#attempts = 0;
    this.#lastSentAt = 0;
  }

  #evaluate(): void {
    const { zone, input, preset, soundMode } = this.#state;
    if (zone !== 'ON' || input === undefined || preset === undefined) {
      return;
    }
    const rear = this.#enabled && this.#inputs.has(input.toUpperCase());
    const wantPreset = rear ? REAR_PRESET : NORMAL_PRESET;

    let command: string | undefined;
    if (preset !== wantPreset) {
      command = `SPPR ${wantPreset}`;
    } else if (rear && this.#soundMode && soundMode !== this.#soundMode) {
      command = soundMode === undefined ? 'MS?' : `MS${this.#soundMode}`;
    }

    if (command === undefined) {
      this.#resetGoal();
      return;
    }
    if (command !== this.#goal) {
      this.#goal = command;
      this.#attempts = 0;
    }
    if (this.#attempts >= this.#maxAttempts) {
      if (this.#attempts === this.#maxAttempts) {
        this.#log.warn('The receiver did not accept "%s" after %d tries; waiting for its state to change', command, this.#attempts);
        this.#attempts++;
      }
      return;
    }
    const sinceLast = Date.now() - this.#lastSentAt;
    if (this.#attempts > 0 && sinceLast < this.#retryMs) {
      this.#schedule(this.#retryMs - sinceLast);
      return;
    }

    this.#attempts++;
    this.#lastSentAt = Date.now();
    this.#log.info(this.#describe(command, input, rear) + (this.#attempts > 1 ? ` (retry ${this.#attempts - 1})` : ''));
    this.#avr.send(command);
    this.#schedule(this.#retryMs);
  }

  #describe(command: string, input: string, rear: boolean): string {
    const source = input === 'NET' ? 'HEOS Music' : input;
    if (command === `SPPR ${REAR_PRESET}`) {
      return `${source} is playing: Speaker Preset ${REAR_PRESET} (rear speakers only)`;
    }
    if (command === `SPPR ${NORMAL_PRESET}`) {
      return rear || this.#enabled
        ? `Input is ${source}: Speaker Preset ${NORMAL_PRESET} (all speakers)`
        : `Switch is off: Speaker Preset ${NORMAL_PRESET} (all speakers)`;
    }
    if (command === 'MS?') {
      return 'Reading the sound mode';
    }
    return `Sound mode: ${this.#soundMode}`;
  }
}
