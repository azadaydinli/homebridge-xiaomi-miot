<p align="center">
  <img src="https://raw.githubusercontent.com/azadaydinli/homebridge-xiaomi-miot/main/banner.svg" width="800">
</p>

<span align="center">

# Homebridge Xiaomi MiOT

A [Homebridge](https://homebridge.io) plugin for controlling **Xiaomi smart home devices** via **Apple HomeKit**. Works with any device that uses the **MiOT protocol**. Supports **local** (IP + token, no internet required) and **MiCloud** (auto-discovery) connection modes.

[![npm](https://img.shields.io/npm/v/homebridge-xiaomi-miot)](https://www.npmjs.com/package/homebridge-xiaomi-miot)
[![npm](https://img.shields.io/npm/dw/homebridge-xiaomi-miot)](https://www.npmjs.com/package/homebridge-xiaomi-miot)
[![npm](https://img.shields.io/npm/dt/homebridge-xiaomi-miot)](https://www.npmjs.com/package/homebridge-xiaomi-miot)
[![Ko-fi](https://img.shields.io/badge/Support%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/azadaydinli)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=github)](https://github.com/sponsors/azadaydinli)

</span>

---

## Features

- **Full MiOT protocol support** — automatically fetches the device spec and maps properties to HomeKit characteristics
- **Local control** — direct LAN communication via IP + token, no internet required
- **MiCloud auto-discovery** — log in once and press **Discover Devices** to auto-populate all your Xiaomi devices
- **Offline detection** — HomeKit shows **"No Response"** when a device loses connectivity; recovers automatically when the device comes back
- **Per-model feature toggles** — enable only the HomeKit controls you actually need (buzzer, LED, child lock, fan speed, swing, screen, ioniser, etc.). Features default to **off**; 83+ device models supported
- **Auto / sleep mode rotation speed** — shows a configurable placeholder speed (default 50 %) instead of 0 % when the device is in auto or sleep mode
- **Minimalist logging** — startup emits a single summary line; only warnings, errors, and offline/online events appear in the log
- **Session caching** — MiCloud session is saved to disk; subsequent discoveries skip re-login
- **Device enable / disable** — expose or hide a device in HomeKit without removing it from config
- **Per-device MiCloud override** — use different cloud credentials for individual devices
- **Custom accessory** mode — manual spec override for unsupported or custom devices
- Homebridge v1 & v2 compatible

---

## Supported Devices

Any Xiaomi device that implements the MiOT protocol is supported. Common examples:

| Category | Brands / Models |
|---|---|
| Smart Fans | Dmaker (`dmaker.fan.*`), Smartmi (`zhimi.fan.*`) |
| Air Purifiers | Xiaomi, Smartmi (`zhimi.airp.*`, `zhimi.airpurifier.*`) |
| Humidifiers | Smartmi, Deerma (`zhimi.humidifier.*`, `deerma.humidifier.*`) |
| Robot Vacuums | Roborock (`roborock.vacuum.*`), Dreame (`dreame.vacuum.*`) |
| Smart Lights | Yeelight (`yeelink.light.*`) |
| Heaters | Smartmi (`zhimi.heater.*`) |
| Smart Outlets | Various (`cuco.plug.*`) |
| And more… | Any device listed on [miot-spec.org](https://home.miot-spec.com) |

---

## Requirements

- [Homebridge](https://homebridge.io) v1.6.0 or later (v2 supported)
- Node.js v18.0.0 or later
- A Xiaomi device with local network access
- **Local mode:** device IP address and 32-character MiOT token
- **MiCloud mode:** Xiaomi account (Mi Home app)

---

## Installation

**Via Homebridge UI (recommended):**

1. Open the Homebridge UI → **Plugins**
2. Search for `homebridge-xiaomi-miot`
3. Click **Install**
4. Open plugin settings, enter your MiCloud credentials and press **Discover Devices**

**Via terminal:**

```bash
npm install -g homebridge-xiaomi-miot
```

---

## Getting the Token

The 32-character MiOT token is required for local control. The easiest way is to use the built-in **Discover Devices** button — tokens are filled in automatically.

Alternatively:
- **Mi Home app** (Android debug mode or rooted device)
- **[miot-cli](https://github.com/al-one/hass-xiaomi-miot)** or similar tools

---

## Configuration

The easiest way to configure is through the **Homebridge UI** — enter your MiCloud credentials and press **Discover Devices** to auto-fill all device details.

For manual JSON configuration:

### Local Mode

```json
{
  "platforms": [
    {
      "platform": "XiaomiMiot",
      "name": "Xiaomi MiOT",
      "devices": [
        {
          "name": "Living Room Fan",
          "ip": "192.168.1.100",
          "token": "your-32-character-token-here",
          "model": "dmaker.fan.p5",
          "pollingInterval": 10000,
          "deviceEnabled": true
        }
      ]
    }
  ]
}
```

### MiCloud Mode

```json
{
  "platforms": [
    {
      "platform": "XiaomiMiot",
      "name": "Xiaomi MiOT",
      "micloud": {
        "username": "your-email@example.com",
        "password": "your-password",
        "country": "de"
      },
      "devices": [
        {
          "name": "Living Room Fan",
          "ip": "192.168.1.100",
          "token": "your-32-character-token-here",
          "pollingInterval": 10000,
          "deviceEnabled": true
        }
      ]
    }
  ]
}
```

---

## Configuration Options

### Platform-level MiCloud credentials (`micloud` object)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `username` | string | — | Xiaomi account email |
| `password` | string | — | Xiaomi account password |
| `country` | string | `"de"` | Server region: `cn` `de` `sg` `tw` `us` `ru` `in` `i2` |
| `forceMiCloud` | boolean | `false` | Route all control through MiCloud even when local is available |

### Device options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | string | — | Device name shown in HomeKit |
| `ip` | string | — | Local IP address of the device |
| `token` | string | — | 32-character MiOT token |
| `model` | string | auto | Device model (e.g. `dmaker.fan.p5`). Leave empty for auto-detect |
| `deviceId` | string | auto | Device ID. Leave empty for auto-detect |
| `pollingInterval` | number | `10000` | State polling interval in ms |
| `deviceEnabled` | boolean | `true` | Enable or disable this device in HomeKit |
| `autoRotationSpeed` | number | `50` | Fan speed % shown in HomeKit when device is in auto/sleep mode. Set to `0` to disable |
| `customAccessory` | boolean | `false` | Manual accessory mode for unsupported devices |
| `silentLog` | boolean | `false` | Suppress routine log messages for this device |
| `deepDebugLog` | boolean | `false` | Enable verbose debug logging for this device |

### Feature toggles (device options)

Feature toggles control which additional HomeKit controls are exposed for a given device. They all default to `false` (off). Enable only what you need via the **Config UI** or directly in JSON.

| Key | Description |
|-----|-------------|
| `buzzerControl` | Buzzer on/off switch |
| `ledControl` | LED / screen brightness switch |
| `childLockControl` | Child lock switch |
| `modeControl` | Mode selector (e.g. Normal / Nature / Sleep) |
| `fanLevelControl` | Fan speed level control |
| `swingControl` | Oscillation switch |
| `screenControl` | Display on/off switch |
| `ioniserControl` | Ioniser / anion switch |
| `heaterControl` | Heater switch |
| `heatLevelControl` | Heat level control |
| `offDelayControl` | Off-timer control |
| `showTemperature` | Expose temperature sensor characteristic |

> The Config UI automatically shows only the feature toggles that are relevant for your specific device model.

---

## MiCloud Auto-Discovery

1. Enter your Xiaomi account credentials in the **MiCloud Credentials** section of the plugin settings
2. Press **Discover Devices** — the plugin fetches all MiOT-compatible devices with their IPs and tokens
3. Newly found devices are added automatically; existing devices are not duplicated

> **Identity verification:** Xiaomi may prompt for verification on first login from a new IP. Follow the on-screen instructions: open the verification link in your browser, approve the login, then press **Retry** in the plugin UI.

---

## Offline Detection

When a device stops responding (power cut, network issue, etc.), the plugin detects the absence of poll responses after **4 consecutive missed cycles** and marks the device offline. HomeKit will show **"No Response"** for that device.

When the device comes back online the plugin automatically restores normal operation — no restart needed.

The detection window is `pollingInterval × 4`. With the default 10-second interval this means a 40-second detection delay.

---

## Local vs MiCloud

| | Local | MiCloud |
|---|---|---|
| Internet required | No | For discovery and cloud control |
| Setup | Manual (IP + token) | Easy — Discover button auto-fills |
| Response time | ~0.2–0.5 s | ~1–3 s |
| Works without internet | Yes | No |
| Works remotely | No | Yes (with `forceMiCloud`) |

---

## Troubleshooting

**Discover Devices returns nothing**
- Check that your MiCloud credentials match those in the Mi Home app
- Select the correct **Country** region for your account
- If identity verification appears, open the link shown, approve it in your browser, then press **Retry**

**Token invalid / device not responding**
- Tokens can change when a device is reset or re-paired — re-run Discover Devices
- Make sure Homebridge is on the same local network as the device
- Assign a static DHCP lease to prevent IP address changes

**Device shows "No Response" in HomeKit**
- This is intentional when the device is powered off or unreachable — the plugin correctly reports the offline state
- Check the device is powered on and connected to Wi-Fi
- The plugin recovers automatically once the device is back online — no restart needed

**Device identified but HomeKit tile missing**
- The plugin fetches the MiOT spec from Xiaomi servers on first run — allow 30–60 seconds and check the logs
- If the device model is unsupported, try enabling **Custom Accessory** mode

**Fan speed shows 0 % in auto mode**
- This is fixed in v1.1.1+ — the plugin shows 50 % by default. Adjust with `"autoRotationSpeed"` in device config

---

## Support

If this plugin is useful to you, consider supporting its development:

[![Ko-fi](https://img.shields.io/badge/Support%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/azadaydinli)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=github)](https://github.com/sponsors/azadaydinli)

---

## Contributing

Contributions are welcome! Please open an [issue](https://github.com/azadaydinli/homebridge-xiaomi-miot/issues) or submit a pull request.

---

## License

MIT © [Azad Aydınlı](https://github.com/azadaydinli)
