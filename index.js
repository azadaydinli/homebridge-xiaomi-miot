'use strict';

const fs = require('fs').promises;
const path = require('path');
// Bundled MiOT library
const MIOT_ROOT = path.join(__dirname, 'vendor/miot/lib') + '/';
const MiotDevice    = require(MIOT_ROOT + 'protocol/MiotDevice.js');
const DeviceFactory = require(MIOT_ROOT + 'factories/DeviceFactory.js');
const Constants     = require(MIOT_ROOT + 'constants/Constants.js');
const Logger        = require(MIOT_ROOT + 'utils/Logger.js');
const Events        = require(MIOT_ROOT + 'constants/Events.js');

const PLUGIN_NAME = 'homebridge-xiaomi-miot';
const PLATFORM_NAME = 'XiaomiMiot';
const PLUGIN_VERSION = '1.2.1';

/* ── Silence verbose MiOT startup logs ── */
const MIOT_INFO_SUPPRESS = [
  'Initializing device services',   'Device services:',
  'Initializing device properties', 'Device properties:',
  'Initializing device actions',    'Device actions:',
  'Initializing accessory!',        'Accessory successfully initialized!',
  'Doing initial property fetch',   'Starting property polling',
  'Filter used time:',              'Filter left time:',
  'Filter life level:',             'Device identified',
  'Model known:',                   'Device found!',
  'Connected to device:',           'Using module class for device type',
  'Device class for device type',
];
function quietLog(log) {
  const mute = m => MIOT_INFO_SUPPRESS.some(p => String(m).includes(p));
  return {
    info:  (m, ...a) => { if (!mute(m)) log.info(m, ...a); },
    warn:  (m, ...a) => log.warn(m, ...a),
    error: (m, ...a) => log.error(m, ...a),
    debug: (m, ...a) => log.debug(m, ...a),
  };
}

let Homebridge;

module.exports = (homebridge) => {
  Homebridge = homebridge;
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, XiaomiMiotPlatform, true);
};

/* ─────────────────────────── Platform ─────────────────────────── */

class XiaomiMiotPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cachedAccessories = [];

    if (this.api) {
      this.api.on('didFinishLaunching', () => this._initDevices());
    }
  }

  configureAccessory(accessory) {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.cachedAccessories.push(accessory);
  }

  _initDevices() {
    const devices = (this.config.devices || []).filter(Boolean);
    if (devices.length === 0) {
      this.log.warn('No devices configured.');
      return;
    }
    this.log.info(`Starting ${devices.length} device(s)…`);
    for (const deviceConfig of devices) this._initDevice(deviceConfig);
    this._removeStaleCachedAccessories();
  }

  _initDevice(deviceConfig) {
    const ctrl = new XiaomiMiotDeviceController(
      this.log, deviceConfig, this.config.micloud, this.api
    );
    const cached = this.cachedAccessories.find(a => a.UUID === ctrl.uuid);
    if (cached) {
      ctrl.setCachedAccessory(cached);
      this.cachedAccessories = this.cachedAccessories.filter(a => a !== cached);
    }
    ctrl.setup().catch(err => {
      this.log.error(`[${deviceConfig.name || 'device'}] Setup error: ${err.message || err}`);
    });
  }

  _removeStaleCachedAccessories() {
    if (this.cachedAccessories.length > 0) {
      this.log.debug(`Removing ${this.cachedAccessories.length} stale cached accessories`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.cachedAccessories);
      this.cachedAccessories = [];
    }
  }
}

/* ─────────────────────────── Device Controller ─────────────────── */

class XiaomiMiotDeviceController {
  constructor(log, config, globalMiCloud, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.logger = new Logger(quietLog(log), config.name);

    if (!config.ip)    this.logger.error("'ip' is required but missing!");
    if (!config.token) this.logger.error("'token' is required but missing!");

    this.name            = config.name;
    this.ip              = config.ip;
    this.token           = config.token;
    this.deviceId        = config.deviceId;
    this.model           = config.model;
    this.pollingInterval = config.pollingInterval || Constants.DEFAULT_POLLING_INTERVAL;
    if (this.pollingInterval < 500) this.pollingInterval *= 1000; // seconds → ms
    this.propertyChunkSize = config.propertyChunkSize;
    this.prefsDir        = config.prefsDir || api.user.storagePath() + '/.xiaomiMiot/';
    if (!this.prefsDir.endsWith('/')) this.prefsDir += '/';
    this.specDir         = this.prefsDir + 'spec/';
    this.deviceInfoFile  = this.prefsDir + 'info_' + this.ip.split('.').join('') + '_' + this.token;
    this.cachedMiCloudSessionFile = api.user.storagePath() + Constants.MICLOUD_SESSION_CACHE_LOCATION;
    this.isCustomAccessory = config.customAccessory ?? false;
    this.deepDebugLog    = config.deepDebugLog ?? false;
    this.silentLog       = config.silentLog ?? false;
    this.deviceEnabled   = config.deviceEnabled ?? true;

    this.miCloudConfig   = { global: globalMiCloud, device: config.micloud };
    this.cachedDeviceInfo = {};
    this.miotDevice      = null;
    this.device          = null;
    this._cachedAccessory = null;

    this.uuid = config.deviceId
      ? Homebridge.hap.uuid.generate(this.token + this.ip + this.deviceId + PLATFORM_NAME)
      : Homebridge.hap.uuid.generate(this.token + this.ip + PLATFORM_NAME);

    this.logger.setDeepDebugLogEnabled(this.deepDebugLog);
    this.logger.setSilentLogEnabled(this.silentLog);
  }

  setCachedAccessory(accessory) {
    this._cachedAccessory = accessory;
  }

  async setup() {
    await this._ensureDir(this.prefsDir);
    await this._ensureDir(this.specDir);
    await this._loadDeviceInfo();
    await this._loadCachedMiCloudSession();
    this._startMiotDevice();
  }

  _startMiotDevice() {
    const deviceId = this.deviceId || this.cachedDeviceInfo.deviceId;
    const model    = this.model    || this.cachedDeviceInfo.model;

    this.miotDevice = new MiotDevice(this.ip, this.token, deviceId, model, this.name, this.logger);
    this.miotDevice.setPollingInterval(this.pollingInterval);
    this.miotDevice.setMiCloudConfig(this.miCloudConfig);

    this.miotDevice.on(Events.MIOT_DEVICE_IDENTIFIED,  (d) => {
      this._onIdentified(d).catch(err => this.logger.error(`Device init error: ${err.message || err}`));
    });
    this.miotDevice.on(Events.MIOT_DEVICE_SPEC_FETCHED,(d) => this._saveMiotSpec(d));
    this.miotDevice.on(Events.MIOT_DEVICE_CONNECTED,   (d) => this._saveDeviceInfo(d));

    this.miotDevice.identify();
  }

  async _onIdentified(miotDevice) {
    if (this.device) return;
    try {
      this.device = await DeviceFactory.createDevice(
        miotDevice, this.specDir, this.name, this.isCustomAccessory, this.logger
      );
      if (!this.device) {
        this.logger.warn('Device creation failed!');
        return;
      }
      await this.device.initDevice(this.propertyChunkSize);
      this._registerAccessory();
    } catch (err) {
      this.logger.error(`Failed to initialize device: ${err.message || err}`);
    }
  }

  _registerAccessory() {
    // Unregister any previously cached accessory for this UUID
    if (this._cachedAccessory) {
      this.logger.debug('Replacing cached accessory');
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this._cachedAccessory]);
      this._cachedAccessory = null;
    }

    this.device.initDeviceAccessory(this.uuid, this.config, this.api, this.cachedDeviceInfo);

    if (this.device.getAccessoryWrapper() && this.device.getAccessories().length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.device.getAccessories());

      if (this.deviceEnabled) {
        this.miotDevice.startPropertyPolling();
        this._startOfflineDetection();
        this._patchAutoModeRotationSpeed();
      } else {
        this.logger.warn('Device disabled — polling not started');
      }
    }
  }

  _startOfflineDetection() {
    const { HapStatusError, HAPStatus } = this.api.hap;

    let online      = false;
    let lastUpdate  = Date.now();
    const threshold = this.pollingInterval * 4;  // 4 missed polls → offline

    /* ── Iterate every HAP characteristic across all accessories ── */
    const eachChar = (fn) => {
      const accessories = this.device ? this.device.getAccessories() : [];
      accessories.forEach(acc => {
        acc.services.forEach(svc => {
          svc.characteristics.forEach(char => fn(char));
        });
      });
    };

    /* ── Install error-throwing getHandler on every characteristic ── */
    const pushOffline = () => {
      this.miotDevice.localConnected = false;
      eachChar(char => {
        /* Save original handler (once only) and replace with error thrower */
        if (!Object.prototype.hasOwnProperty.call(char, '_xiaomiOrigGet')) {
          char._xiaomiOrigGet = char.getHandler !== undefined ? char.getHandler : null;
          char.onGet(() => {
            throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          });
        }
      });
      this.logger.warn(`[OfflineDetect] ${this.name} — offline.`);
    };

    /* ── Restore original getHandlers when device comes back ── */
    const pushOnline = () => {
      this.miotDevice.localConnected = true;
      eachChar(char => {
        if (Object.prototype.hasOwnProperty.call(char, '_xiaomiOrigGet')) {
          if (char._xiaomiOrigGet) {
            char.onGet(char._xiaomiOrigGet);
          } else {
            char.removeOnGet();
          }
          delete char._xiaomiOrigGet;
        }
      });
    };

    /* ── Track online state ── */
    this.miotDevice.on(Events.MIOT_DEVICE_ALL_PROPERTIES_UPDATED, () => {
      const wasOffline = !online;
      lastUpdate = Date.now();
      online = true;
      clearTimeout(this._offlineStartupTimeout);
      if (wasOffline) pushOnline();
    });

    /* Case 1: never connected within startup window */
    this._offlineStartupTimeout = setTimeout(() => {
      if (!online) pushOffline();
    }, threshold);

    /* Case 2: was online but stopped updating */
    this._offlineDetectionTimer = setInterval(() => {
      if (!online) return;
      const elapsed = Date.now() - lastUpdate;
      if (elapsed > threshold) {
        online = false;
        pushOffline();
      }
    }, this.pollingInterval);
  }

  /* ── Auto mode rotation speed patch ── */

  _patchAutoModeRotationSpeed() {
    const autoSpeed = this.config.autoRotationSpeed ?? 50;
    if (!autoSpeed) return; // 0 = disabled

    const RS_UUID = this.api.hap.Characteristic.RotationSpeed.UUID;
    const dev     = this.device;
    if (!dev) return;

    /* Find the RotationSpeed characteristic */
    let rsChar = null;
    outer: for (const acc of dev.getAccessories()) {
      for (const svc of acc.services) {
        for (const char of svc.characteristics) {
          if (char.UUID === RS_UUID) { rsChar = char; break outer; }
        }
      }
    }

    if (!rsChar || !rsChar.getHandler) return;

    /* 1) Override getHandler — for HomeKit GET requests */
    const origHandler = rsChar.getHandler;
    rsChar.onGet(async (...args) => {
      const val = await origHandler(...args);
      if (val === 0 && this._isInAutoOrSleepMode(dev)) return autoSpeed;
      return val;
    });

    /* 2) Fix push updates — the MiOT layer calls updateValue(0) after each poll.
          Our listener runs after it (registered later) and corrects the value. */
    this.miotDevice.on(Events.MIOT_DEVICE_ALL_PROPERTIES_UPDATED, () => {
      if (rsChar && this._isInAutoOrSleepMode(dev)) {
        rsChar.updateValue(autoSpeed);
      }
    });

    this.logger.debug(`[AutoSpeed] RotationSpeed patched: ${autoSpeed}% shown in auto/sleep mode`);
  }

  _isInAutoOrSleepMode(dev) {
    return (typeof dev.isAutoModeEnabled  === 'function' && dev.isAutoModeEnabled())
        || (typeof dev.isSleepModeEnabled === 'function' && dev.isSleepModeEnabled());
  }

  /* ── Persistence helpers ── */

  _saveDeviceInfo(miotDevice) {
    if (!miotDevice) return;
    this.cachedDeviceInfo.model      = miotDevice.getModel();
    this.cachedDeviceInfo.deviceId   = miotDevice.getDeviceId();
    this.cachedDeviceInfo.firmwareRev = miotDevice.getFirmwareRevision();
    fs.writeFile(this.deviceInfoFile, JSON.stringify(this.cachedDeviceInfo), 'utf8')
      .then(() => this.logger.debug('Device info saved'))
      .catch(e => this.logger.debug(`Could not save device info: ${e}`));
  }

  async _loadDeviceInfo() {
    try {
      const raw = await fs.readFile(this.deviceInfoFile, 'utf8');
      if (raw) {
        this.cachedDeviceInfo = JSON.parse(raw);
        this.logger.debug(`Loaded cached device info: ${this.cachedDeviceInfo.model}`);
      }
    } catch { /* no cached info */ }
  }

  async _loadCachedMiCloudSession() {
    try {
      const raw = await fs.readFile(this.cachedMiCloudSessionFile, 'utf8');
      if (raw) {
        this.miCloudConfig.cachedSession = JSON.parse(raw);
        this.logger.debug(`Loaded cached MiCloud session from: ${this.miCloudConfig.cachedSession.loggedInAt}`);
      }
    } catch { /* no cached session */ }
  }

  _saveMiotSpec(miotDevice) {
    if (!miotDevice?.getMiotSpec()) return;
    const fileName = this.specDir + miotDevice.getModel() + '.spec.json';
    fs.writeFile(fileName, JSON.stringify(miotDevice.getMiotSpec(), null, 2), 'utf8')
      .then(() => this.logger.debug('MiOT spec saved'))
      .catch(e => this.logger.debug(`Could not save MiOT spec: ${e}`));
  }

  async _ensureDir(dir) {
    try { await fs.access(dir); }
    catch { await fs.mkdir(dir, { recursive: true }); }
  }
}
