import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as hap from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformConfig } from 'homebridge';

import registerPlugin from '../src/index.ts';
import { PLATFORM_NAME, PLUGIN_NAME, RearSpeakersPlatform } from '../src/platform.ts';
import { MockAvr } from './mock-avr.ts';
import { testLogger, waitFor } from './helpers.ts';
import type { TestLogger } from './helpers.ts';

/** Just enough of Homebridge's PlatformAccessory, backed by a real HAP accessory. */
class FakePlatformAccessory {
  readonly UUID: string;
  readonly displayName: string;
  context: Record<string, unknown> = {};
  readonly #accessory: hap.Accessory;

  constructor(displayName: string, uuid: string) {
    this.displayName = displayName;
    this.UUID = uuid;
    this.#accessory = new hap.Accessory(displayName, uuid);
  }

  getService(type: typeof hap.Service.Switch | typeof hap.Service.AccessoryInformation) {
    return this.#accessory.getService(type);
  }

  addService(type: typeof hap.Service.Switch, name: string) {
    return this.#accessory.addService(type, name);
  }
}

class FakeApi extends EventEmitter {
  readonly hap = hap;
  readonly platformAccessory = FakePlatformAccessory;
  readonly registered: FakePlatformAccessory[] = [];
  readonly unregistered: FakePlatformAccessory[] = [];
  updates = 0;
  platforms: [string, unknown][] = [];

  registerPlatform(name: string, constructor: unknown) {
    this.platforms.push([name, constructor]);
  }
  registerPlatformAccessories(plugin: string, platform: string, accessories: FakePlatformAccessory[]) {
    assert.equal(plugin, PLUGIN_NAME);
    assert.equal(platform, PLATFORM_NAME);
    this.registered.push(...accessories);
  }
  unregisterPlatformAccessories(_plugin: string, _platform: string, accessories: FakePlatformAccessory[]) {
    this.unregistered.push(...accessories);
  }
  updatePlatformAccessories() {
    this.updates++;
  }
}

function asLogging(log: TestLogger): Logging {
  return Object.assign(log.info, log, { success: log.info, log: log.info, prefix: 'test' }) as unknown as Logging;
}

describe('RearSpeakersPlatform', () => {
  let avr: MockAvr;
  let api: FakeApi;
  let log: TestLogger;

  function launch(config: Partial<PlatformConfig>, cached: FakePlatformAccessory[] = []) {
    const platform = new RearSpeakersPlatform(
      asLogging(log),
      { platform: PLATFORM_NAME, ...config } as PlatformConfig,
      api as unknown as API,
    );
    cached.forEach((accessory) => platform.configureAccessory(accessory as never));
    api.emit('didFinishLaunching');
    return platform;
  }

  function switchOf(accessory: FakePlatformAccessory) {
    const service = accessory.getService(hap.Service.Switch);
    assert.ok(service, 'switch service');
    return service.getCharacteristic(hap.Characteristic.On);
  }

  beforeEach(async () => {
    avr = new MockAvr();
    await avr.start();
    api = new FakeApi();
    log = testLogger();
  });

  afterEach(async () => {
    api.emit('shutdown');
    await avr.stop();
  });

  it('registers the platform under its alias', () => {
    registerPlugin(api as unknown as API);
    assert.deepEqual(api.platforms, [[PLATFORM_NAME, RearSpeakersPlatform]]);
  });

  it('adds a "Rear Speakers" switch that starts on and drives the receiver', async () => {
    launch({ name: 'Rear Speakers', host: '127.0.0.1', port: avr.port });
    assert.equal(api.registered.length, 1);
    const [accessory] = api.registered;
    const on = switchOf(accessory);
    assert.equal(await on.handleGetRequest(), true);
    assert.equal(accessory.getService(hap.Service.AccessoryInformation)?.getCharacteristic(hap.Characteristic.SerialNumber).value, '127.0.0.1');

    await waitFor(() => avr.clientCount === 1, 2000, 'connection');
    avr.spotifyConnect();
    await waitFor(() => avr.state.preset === 2 && avr.state.soundMode === 'MCH STEREO', 3000, 'rear preset');

    await on.handleSetRequest(false);
    assert.equal(accessory.context.enabled, false);
    assert.equal(api.updates, 1);
    await waitFor(() => avr.state.preset === 1, 3000, 'normal preset after switching off');
  });

  it('restores a cached switch that was turned off', async () => {
    const cached = new FakePlatformAccessory('Rear Speakers', hap.uuid.generate(`${PLUGIN_NAME}:127.0.0.1`));
    cached.addService(hap.Service.Switch, 'Rear Speakers');
    cached.context.enabled = false;
    launch({ host: '127.0.0.1', port: avr.port }, [cached]);
    assert.equal(api.registered.length, 0);
    assert.equal(await switchOf(cached).handleGetRequest(), false);
    await waitFor(() => avr.clientCount === 1, 2000, 'connection');
    avr.spotifyConnect();
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(avr.state.preset, 1);
  });

  it('removes a cached accessory left over from a different receiver address', () => {
    const stale = new FakePlatformAccessory('Old', hap.uuid.generate(`${PLUGIN_NAME}:10.0.0.9`));
    launch({ host: '127.0.0.1', port: avr.port }, [stale]);
    assert.deepEqual(api.unregistered, [stale]);
    assert.equal(api.registered.length, 1);
  });

  it('explains a missing host instead of starting', () => {
    launch({});
    assert.equal(api.registered.length, 0);
    assert.ok(log.lines.some((line) => line.level === 'error' && line.message.includes('"host"')));
  });
});
