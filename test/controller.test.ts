import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AvrConnection } from '../src/avr.ts';
import { PresetController } from '../src/controller.ts';
import { MockAvr } from './mock-avr.ts';
import { sleep, testLogger, waitFor } from './helpers.ts';
import type { TestLogger } from './helpers.ts';

describe('PresetController against a receiver', () => {
  let avr: MockAvr;
  let connection: AvrConnection;
  let controller: PresetController;
  let log: TestLogger;

  async function connect(enabled = true, options: { heartbeatMs?: number } = {}) {
    connection = new AvrConnection(
      { host: '127.0.0.1', port: avr.port, commandGapMs: 20, heartbeatMs: options.heartbeatMs ?? 30_000 },
      log,
    );
    controller = new PresetController(
      connection,
      { inputs: ['NET'], soundMode: 'MCH STEREO', settleMs: 30, retryMs: 250, maxAttempts: 4 },
      log,
      enabled,
    );
    connection.start();
    await waitFor(() => controller.state.preset !== undefined, 2000, 'initial state');
  }

  /** Lets any pending evaluation and retry play out, then returns the set commands sent meanwhile. */
  async function setsDuring(action: () => void | Promise<void>, settleMs = 600): Promise<string[]> {
    const before = avr.sets.length;
    await action();
    await sleep(settleMs);
    return avr.sets.slice(before);
  }

  beforeEach(async () => {
    avr = new MockAvr();
    await avr.start();
    log = testLogger();
  });

  afterEach(async () => {
    controller?.stop();
    connection?.stop();
    await avr.stop();
  });

  it('Spotify Connect waking the receiver switches to the rear preset and Multi Ch Stereo, fast', async () => {
    await connect();
    const started = Date.now();
    avr.spotifyConnect();
    await waitFor(() => avr.state.preset === 2 && avr.state.soundMode === 'MCH STEREO', 2000, 'rear preset');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `took ${elapsed} ms`);
    assert.deepEqual(avr.sets, ['SPPR 2', 'MSMCH STEREO']);
  });

  it('the TV taking over goes back to the normal preset without touching input or sound mode', async () => {
    await connect();
    avr.spotifyConnect();
    await waitFor(() => avr.state.preset === 2 && avr.state.soundMode === 'MCH STEREO');
    const sent = await setsDuring(() => avr.tv());
    assert.deepEqual(sent, ['SPPR 1']);
    assert.equal(avr.state.preset, 1);
    assert.equal(avr.state.input, 'SAT/CBL');
    assert.equal(avr.state.soundMode, 'AURO2DSURR');
  });

  it('sends nothing when the receiver is already right', async () => {
    avr.state = { power: 'ON', input: 'NET', preset: 2, soundMode: 'MCH STEREO' };
    await connect();
    await sleep(500);
    assert.deepEqual(avr.sets, []);
  });

  it('with the switch off, Spotify plays on all speakers', async () => {
    await connect(false);
    const sent = await setsDuring(() => avr.spotifyConnect());
    assert.deepEqual(sent, []);
    assert.equal(avr.state.preset, 1);
  });

  it('turning the switch off during Spotify restores the normal preset; on again goes back to rear', async () => {
    await connect();
    avr.spotifyConnect();
    await waitFor(() => avr.state.preset === 2 && avr.state.soundMode === 'MCH STEREO');

    assert.deepEqual(await setsDuring(() => controller.setEnabled(false)), ['SPPR 1']);
    assert.equal(avr.state.preset, 1);

    assert.deepEqual(await setsDuring(() => controller.setEnabled(true)), ['SPPR 2']);
    assert.equal(avr.state.preset, 2);
  });

  it('turning the switch on while watching TV changes nothing', async () => {
    avr.tv();
    await connect(false);
    assert.deepEqual(await setsDuring(() => controller.setEnabled(true)), []);
  });

  it('leaves a receiver in standby alone', async () => {
    avr.state = { power: 'STANDBY', input: 'SAT/CBL', preset: 2, soundMode: 'MCH STEREO' };
    await connect();
    await sleep(500);
    assert.deepEqual(avr.sets, []);
  });

  it('never sends power or input commands', async () => {
    await connect();
    avr.spotifyConnect();
    await sleep(400);
    avr.tv();
    await sleep(400);
    avr.standby();
    avr.spotifyConnect();
    await sleep(400);
    assert.ok(avr.sets.length > 0);
    assert.deepEqual(
      avr.sets.filter((command) => /^(PW|ZM|SI)/.test(command)),
      [],
    );
  });

  it('retries a command the receiver ignored while waking up', async () => {
    avr.bootMs = 600;
    await connect();
    avr.spotifyConnect();
    await waitFor(() => avr.state.preset === 2 && avr.state.soundMode === 'MCH STEREO', 3000, 'rear preset after boot');
    assert.ok(avr.sets.filter((command) => command === 'SPPR 2').length > 1, 'expected at least one retry');
  });

  it('gives up on a sound mode the receiver refuses instead of looping', async () => {
    avr.refusedSoundModes.add('MCH STEREO');
    await connect();
    avr.spotifyConnect();
    await sleep(2500);
    assert.equal(avr.state.preset, 2);
    const tries = avr.sets.filter((command) => command === 'MSMCH STEREO').length;
    assert.equal(tries, 4);
    assert.ok(log.lines.some((line) => line.level === 'warn' && line.message.includes('MSMCH STEREO')));
    await sleep(800);
    assert.equal(avr.sets.filter((command) => command === 'MSMCH STEREO').length, 4);
  });

  it('reconnects after the connection drops and catches up with changes it missed', async () => {
    await connect();
    avr.dropClients();
    await waitFor(() => !connection.connected, 1000, 'disconnect');
    avr.state = { power: 'ON', input: 'NET', preset: 1, soundMode: 'STEREO' };
    await waitFor(() => avr.state.preset === 2 && avr.state.soundMode === 'MCH STEREO', 4000, 'rear preset after reconnect');
  });

  it('notices a silent, half-open connection and reconnects', async () => {
    await connect(true, { heartbeatMs: 150 });
    avr.silent = true;
    let reconnected = false;
    connection.once('disconnected', () => connection.once('connected', () => (reconnected = true)));
    await waitFor(() => !connection.connected, 2000, 'heartbeat to drop the connection');
    avr.silent = false;
    await waitFor(() => reconnected, 4000, 'reconnect');
  });
});
