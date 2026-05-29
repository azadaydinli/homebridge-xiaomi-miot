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

- **Full MiOT protocol support** — the plugin automatically fetches the device spec and maps every property to a HomeKit characteristic
- **Local control** — direct LAN communication via IP + token, no internet required
- **MiCloud auto-discovery** — log in once and the Discover Devices button finds all your Xiaomi devices automatically
- **Per-device MiCloud override** — use different cloud credentials for individual devices
- **Force MiCloud** — route all control through the cloud even when local is available
- **Polling** — configurable polling interval to keep device state in sync
- **Custom accessory** mode — manual spec override for unsupported or custom devices
- **Device enable / disable** — expose or hide a device from HomeKit without removing it from config
- **Silent log / Deep debug log** — control verbosity per device
- **Session caching** — MiCloud session token is saved to disk; subsequent discoveries skip re-login
- **Custom config UI** — built-in Homebridge UI with one-click device discovery
- Homebridge v1 & v2 compatible

---

## Supported Devices

Any Xiaomi device that implements the MiOT protocol is supported. Common examples:

| Category | Brands / Models |
|---|---|
| Smart Fans | Dmaker (`dmaker.fan.*`), Smartmi (`zhimi.fan.*`) |
| Air Purifiers | Xiaomi, Smartmi (`zhimi.airpurifier.*`) |
| Humidifiers | Smartmi, Deerma (`zhimi.humidifier.*`) |
| Robot Vacuums | Roborock (`roborock.vacuum.*`), Dreame (`dreame.vacuum.*`) |
| Smart Lights | Yeelight (`yeelink.light.*`) |
| Air Conditioners | Various (`lumi.*`, `xiaomi.aircondition.*`) |
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
4. Open plugin settings, enter your MiCloud credentials and press **Discover Devices** to auto-populate your devices

**Via terminal:**

```bash
npm install -g homebridge-xiaomi-miot
```

---

## Getting the Token

The 32-character MiOT token is required for local control. You can obtain it:

- **Via MiCloud discovery** — use the built-in **Discover Devices** button; tokens are filled in automatically
- **Via Mi Home app** (Android debug mode or rooted device)
- **Via [miot-cli](https://github.com/al-one/hass-xiaomi-miot/blob/master/README_zh.md)** or similar tools

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

### Platform-level MiCloud Credentials (`micloud` object)

Used for auto-discovery and optional cloud control. Configured once, shared by all devices.

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `username` | string | Yes | — | Xiaomi account email |
| `password` | string | Yes | — | Xiaomi account password |
| `country` | string | No | `"de"` | Server region: `cn`, `de`, `sg`, `tw`, `us`, `ru`, `in`, `i2` |
| `forceMiCloud` | boolean | No | `false` | Route all control through MiCloud even when local is available |

### Device Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `name` | string | Yes | — | Device name in HomeKit |
| `ip` | string | Yes | — | Local IP address of the device |
| `token` | string | Yes | — | 32-character MiOT token |
| `model` | string | No | auto | Device model identifier (e.g. `dmaker.fan.p5`). Leave empty for auto-detect. |
| `deviceId` | string | No | auto | Device ID. Leave empty for auto-detect. |
| `pollingInterval` | number | No | `10000` | How often to poll the device for state updates (ms) |
| `deviceEnabled` | boolean | No | `true` | Enable or disable this device in HomeKit |
| `customAccessory` | boolean | No | `false` | Use custom/manual accessory mode |
| `silentLog` | boolean | No | `false` | Suppress routine log messages for this device |
| `deepDebugLog` | boolean | No | `false` | Enable verbose debug logging for this device |

### Per-device MiCloud Override (`micloud` object inside a device)

Override the global MiCloud credentials for a specific device.

| Option | Type | Description |
|--------|------|-------------|
| `username` | string | Xiaomi account email for this device |
| `password` | string | Xiaomi account password for this device |
| `country` | string | Server region for this device |

---

## MiCloud Auto-Discovery

1. Enter your Xiaomi account credentials in the **MiCloud Credentials** section of the plugin settings
2. Press **Discover Devices** — the plugin logs into your account and fetches all MiOT-compatible devices with their IP addresses and tokens
3. Newly found devices are added automatically; existing devices are not duplicated

> **Note:** Xiaomi may require identity verification on first login from a new IP. Follow the on-screen instructions: open the verification link, approve the login, and the plugin will detect the approval automatically.

---

## Local vs MiCloud

| | Local | MiCloud |
|---|---|---|
| Internet required | No | For discovery and cloud control |
| Setup | Manual (IP + token required) | Easy — Discover button auto-fills |
| Response time | ~0.2–0.5 s | ~1–3 s |
| Works remotely | No | Yes (with `forceMiCloud`) |
| Works without cloud | Yes | No |

---

## Troubleshooting

**Discover Devices returns nothing**
- Check your MiCloud credentials are correct in the Mi Home app
- Select the correct **Country** region that matches your account
- If identity verification is required, open the provided link, approve it, and wait for the plugin to detect the approval

**"Token invalid" / device not responding**
- Tokens can change when the device is reset or re-paired — re-run Discover Devices
- Make sure Homebridge is on the same local network as the device
- Confirm the IP address is correct and hasn't changed (use a static DHCP lease)

**Device identified but HomeKit tile missing**
- The plugin needs to fetch the MiOT spec from Xiaomi's servers on first run — allow 30–60 seconds and check the logs
- If the device model is unsupported, try enabling **Custom Accessory** mode

**Device shows as "Not Responding" in HomeKit**
- Check the device is powered on and connected to Wi-Fi
- Try restarting Homebridge
- Reduce `pollingInterval` if the device is slow to respond, or increase it to reduce load

**Too many log messages**
- Enable **Silent Log** for the affected device in the plugin settings

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
