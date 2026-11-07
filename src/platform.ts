import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { AvrConnection } from './avr.ts';
import { PresetController } from './controller.ts';

export const PLUGIN_NAME = 'homebridge-marantz-rear-speakers';
export const PLATFORM_NAME = 'MarantzRearSpeakers';

export interface RearSpeakersConfig extends PlatformConfig {
  host?: string;
  port?: number;
  inputs?: string[];
  soundMode?: string;
}

interface AccessoryContext {
  enabled?: boolean;
}

export class RearSpeakersPlatform implements DynamicPlatformPlugin {
  readonly log: Logging;
  readonly config: RearSpeakersConfig;
  readonly api: API;
  readonly #cached: PlatformAccessory<AccessoryContext>[] = [];
  #avr: AvrConnection | undefined;
  #controller: PresetController | undefined;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.config = config as RearSpeakersConfig;
    this.api = api;
    api.on('didFinishLaunching', () => this.#setUp());
    api.on('shutdown', () => {
      this.#controller?.stop();
      this.#avr?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.#cached.push(accessory as PlatformAccessory<AccessoryContext>);
  }

  #setUp(): void {
    const host = this.config.host?.trim();
    if (!host) {
      this.log.error('Set "host" to the receiver\'s IP address or hostname.');
      this.#unregister(this.#cached);
      return;
    }

    const { hap } = this.api;
    const name = this.config.name?.trim() || 'Rear Speakers';
    const uuid = hap.uuid.generate(`${PLUGIN_NAME}:${host}`);

    this.#unregister(this.#cached.filter((accessory) => accessory.UUID !== uuid));
    let accessory = this.#cached.find((accessory) => accessory.UUID === uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory<AccessoryContext>(name, uuid);
      accessory.context.enabled = true;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.setCharacteristic(hap.Characteristic.Manufacturer, 'Marantz')
      .setCharacteristic(hap.Characteristic.Model, 'Speaker Preset Switch')
      .setCharacteristic(hap.Characteristic.SerialNumber, host);

    const service = accessory.getService(hap.Service.Switch) ?? accessory.addService(hap.Service.Switch, name);

    const avr = new AvrConnection({ host, port: this.config.port ?? 23 }, this.log);
    const controller = new PresetController(
      avr,
      {
        inputs: this.config.inputs?.length ? this.config.inputs : ['NET'],
        soundMode: this.config.soundMode ?? 'MCH STEREO',
      },
      this.log,
      accessory.context.enabled !== false,
    );
    this.#avr = avr;
    this.#controller = controller;

    const saved = accessory;
    service
      .getCharacteristic(hap.Characteristic.On)
      .onGet(() => controller.enabled)
      .onSet((value) => {
        const enabled = value === true;
        saved.context.enabled = enabled;
        this.api.updatePlatformAccessories([saved]);
        this.log.info(enabled ? 'Rear speakers mode on' : 'Rear speakers mode off');
        controller.setEnabled(enabled);
      });

    avr.on('connected', () => this.log.info('Connected to the receiver at %s', host));
    avr.on('disconnected', () => this.log.warn('Lost the connection to the receiver; reconnecting'));
    avr.start();
  }

  #unregister(accessories: PlatformAccessory[]): void {
    if (accessories.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    }
  }
}
