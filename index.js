'use strict';

const fs = require('fs').promises;
// Re-use homebridge-miot's battle-tested library (must be installed alongside)
const MIOT_ROOT = require.resolve('homebridge-miot').replace(/index\.js$/, '');
const MiotDevice   = require(MIOT_ROOT + 'lib/protocol/MiotDevice.js');
const DeviceFactory = require(MIOT_ROOT + 'lib/factories/DeviceFactory.js');
const Constants    = require(MIOT_ROOT + 'lib/constants/Constants.js');
const Logger       = require(MIOT_ROOT + 'lib/utils/Logger.js');
const Events       = require(MIOT_ROOT + 'lib/constants/Events.js');

const PLUGIN_NAME = 'homebridge-xiaomi-miot';
const PLATFORM_NAME = 'XiaomiMiot';
const PLUGIN_VERSION = '1.1.0';

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
    const devices = this.config.devices;
    if (!Array.isArray(devices) || devices.length === 0) {
      this.log.info('No devices configured.');
      return;
    }
    for (const deviceConfig of devices) {
      if (deviceConfig) this._initDevice(deviceConfig);
    }
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
    ctrl.setup();
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
    this.logger = new Logger(log, config.name);

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
    this.logger.info(`Initialising device: ${this.name}`);
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

    this.miotDevice.on(Events.MIOT_DEVICE_IDENTIFIED,  (d) => this._onIdentified(d));
    this.miotDevice.on(Events.MIOT_DEVICE_SPEC_FETCHED,(d) => this._saveMiotSpec(d));
    this.miotDevice.on(Events.MIOT_DEVICE_CONNECTED,   (d) => this._saveDeviceInfo(d));

    this.miotDevice.identify();
  }

  async _onIdentified(miotDevice) {
    if (this.device) return;
    this.logger.info('Device identified — creating accessory...');
    this.device = await DeviceFactory.createDevice(
      miotDevice, this.specDir, this.name, this.isCustomAccessory, this.logger
    );
    if (!this.device) {
      this.logger.warn('Device creation failed!');
      return;
    }
    await this.device.initDevice(this.propertyChunkSize);
    this._registerAccessory();
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
      this.logger.info(`Registering ${this.device.getAccessories().length} accessories`);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.device.getAccessories());

      if (this.deviceEnabled) {
        this.miotDevice.startPropertyPolling();
      } else {
        this.logger.warn('Device disabled — polling not started');
      }
    }
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
