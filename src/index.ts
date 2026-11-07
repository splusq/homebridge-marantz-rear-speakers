import type { API } from 'homebridge';

import { PLATFORM_NAME, RearSpeakersPlatform } from './platform.ts';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, RearSpeakersPlatform);
};
