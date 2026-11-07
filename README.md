# homebridge-marantz-rear-speakers

Play Spotify Connect and other HEOS Music on a Marantz or Denon receiver's **surround (rear) speakers only**, while TV keeps the full surround setup. There's a HomeKit switch to turn the behavior on or off.

The receiver can't do this on its own: it has no "fronts off" setting, and it can't link a speaker preset to an input. This plugin keeps a connection open to the receiver and switches **Speaker Preset** as the input changes:

| Receiver state | Speaker Preset |
| --- | --- |
| HEOS Music (Spotify Connect, AirPlay…), switch on | **2**: rear speakers only, Multi Ch Stereo |
| Any other input, or switch off | **1**: your normal setup |
| Standby | left alone |

The receiver reports every change itself, so the switch happens within a second of Spotify waking the receiver. The plugin sends only Speaker Preset and sound-mode commands. It never powers the receiver on or off, changes the input, or touches the volume.

Built and tested against a Marantz CINEMA 30. Other 2020+ Marantz and Denon receivers with **Speaker Preset** and a **Front B** amp assign should work the same way.

## Set up Speaker Preset 2 on the receiver (once)

Preset 2 has to be set up so only the surrounds play. The trick is **Front B with nothing connected**, which silences the front speakers:

1. **OPTION → Speaker Preset → Preset 2.** On HEOS Music, choose *AVR Options…* first. Everything below then changes Preset 2 only.
2. **Setup → Speakers → Manual Setup → Speaker Layout:**
   - Amp Assign: **9.1ch + Front B**
   - Center: **No**
   - Surround Back: **No**
   - Height: none
   - Subwoofers: **No**
3. **Manual Setup → Front Speaker: B.** Leave the Front B terminals (HEIGHT 3 / FRONT WIDE) empty.
4. **Crossovers → Surround: Full Range**, so the surrounds keep their bass.
5. **OPTION → Speaker Preset → Preset 1** to go back to your normal setup.

Amp Assign and the speaker layout are stored per preset, so Preset 1 isn't affected.

## Install

Install it from the Homebridge UI, or with:

```sh
npm install -g homebridge-marantz-rear-speakers
```

Then add the platform:

```json
{
  "platform": "MarantzRearSpeakers",
  "name": "Rear Speakers",
  "host": "192.168.1.136"
}
```

| Option | Default | |
| --- | --- | --- |
| `host` | (required) | Receiver IP address or hostname |
| `name` | `Rear Speakers` | Switch name in HomeKit and for Siri |
| `port` | `23` | Telnet control port |
| `inputs` | `["NET"]` | Input codes that use the rear speakers. `NET` is HEOS Music. |
| `soundMode` | `MCH STEREO` | Sound mode held while on the rear speakers. Use `""` to leave it alone. |

Running it as a child bridge is recommended.

**Note:** the plugin keeps the receiver's telnet port open the whole time. Other tools that need port 23 may not connect while it runs. Integrations that use the HTTP API, such as homebridge-denon-tv, aren't affected.

## Development

```sh
npm test        # runs against a fake receiver; never touches a real one
npm run mock    # fake receiver on 127.0.0.1:2323 (type: spotify / tv / standby / state)
npm run build
```

Point a local Homebridge at the mock with `"host": "127.0.0.1", "port": 2323` to try it end to end.

## License

MIT
