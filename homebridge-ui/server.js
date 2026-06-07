'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const MiCloud = require(path.join(__dirname, '../src/micloud.js'));

const STORAGE = process.env.HOMEBRIDGE_STORAGE_PATH || '/homebridge';

/* ── Stable device ID ── */
function getDeviceId() {
  const f = path.join(STORAGE, '.xiaomi-miot-device-id');
  try { const id = fs.readFileSync(f, 'utf8').trim(); if (id.length >= 8) return id; } catch {}
  const id = crypto.randomBytes(8).toString('hex').toUpperCase();
  try { fs.writeFileSync(f, id); } catch {}
  return id;
}

const DEVICE_ID    = getDeviceId();
const SESSION_FILE = path.join(STORAGE, '.xiaomi-miot-session.json');

function loadSession()  { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return null; } }
function clearSession() { try { fs.unlinkSync(SESSION_FILE); } catch {} }

function saveSession(cloud, username) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      userId:       cloud.userId,
      ssecurity:    cloud.ssecurity,
      serviceToken: cloud.serviceToken,
      country:      cloud.country,
      username,
      savedAt:      new Date().toISOString(),
    }));
    console.log('[MiCloud] Session saved (ssecurity=' + !!cloud.ssecurity + ')');
  } catch (e) { console.warn('[MiCloud] Could not save session:', e.message); }
}

const LOG_FILE = path.join(STORAGE, 'xiaomi-miot-debug.log');
function flog(m) {
  const line = new Date().toISOString() + ' ' + m + '\n';
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

function makeLogger() {
  return {
    debug: m => flog('[MiCloud] ' + m),
    info:  m => flog('[MiCloud] ' + m),
    warn:  m => flog('[MiCloud] WARN ' + m),
    error: m => flog('[MiCloud] ERR ' + m),
  };
}

/* ── Server ── */

flog('[xiaomi-miot] server.js loaded');

class XiaomiMiotUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    flog('[xiaomi-miot] constructor called');
    this._pending     = null;
    this._discovering = false;
    this._pollResult  = null;

    this.onRequest('/discover', async (body) => {
      const action = body?.action || 'none';
      flog('[xiaomi-miot] /discover called, action=' + action);

      /* ── Poll: client asking "is the result ready?" ── */
      if (action === 'poll') {
        const r = this._pollResult;
        if (!r) return { pending: true };
        this._pollResult = null;
        flog('[xiaomi-miot] /discover poll: delivering cached result');
        if (r.error) throw new Error(r.error);
        return r.result;
      }

      /* ── Normal trigger ── */
      if (this._discovering) {
        flog('[xiaomi-miot] /discover already in progress, rejecting duplicate');
        throw new Error('Discovery already in progress. Please wait.');
      }
      this._discovering = true;
      this._pollResult  = null;

      try {
        const result = await this._discoverImpl(body);
        flog('[xiaomi-miot] /discover done: ' + JSON.stringify(result).slice(0, 120));
        this._pollResult = { result };
        this._push(result);   // pushEvent as bonus (may or may not arrive)
        return result;        // direct response as bonus
      } catch(e) {
        flog('[xiaomi-miot] /discover error: ' + e.message?.slice(0, 80));
        this._pollResult = { error: e.message || String(e) };
        this._push({ error: e.message || String(e) });
        throw e;
      } finally {
        this._discovering = false;
      }
    });

    this.ready();
  }

  /* Push result via event channel (backup for request/response WebSocket) */
  _push(payload) {
    try { this.pushEvent('xm-discover', payload); } catch(e) {
      flog('[xiaomi-miot] pushEvent failed: ' + e.message);
    }
  }

  /* All discover logic extracted here */
  async _discoverImpl(body) {
    const { username, password, country, action, otp } = body || {};
    const logger = makeLogger();

    /* ── OTP (identity/authStart) ── */
    if (action === 'otp' && this._pending) {
      let cloud = this._pending.cloud;
      const { username: u, password: p, country: c } = this._pending;
      if (!cloud) {
        cloud = new MiCloud({ username: u, password: p, country: c, deviceId: DEVICE_ID, logger });
      }
      try {
        await cloud.login({ verifyTicket: otp });
        this._pending = null;
        saveSession(cloud, u);
        return { devices: this._filter(await cloud.getDevices()) };
      } catch (e) {
        if (e.notificationUrl) {
          this._pending = { username: u, password: p, country: c, cloud };
          return this._needVerify(e);
        }
        throw new Error(e.message);
      }
    }

    /* ── Retry after STS/identity approval ── */
    if (action === 'retry' && this._pending) {
      const { username: u, password: p, country: c } = this._pending;
      const cloud = this._pending.cloud || new MiCloud({ username: u, password: p, country: c, deviceId: DEVICE_ID, logger });
      try {
        await cloud.login();
        this._pending = null;
        saveSession(cloud, u);
        return { devices: this._filter(await cloud.getDevices()) };
      } catch (e) {
        if (e.notificationUrl) {
          this._pending = { ...this._pending, cloud };
          return this._needVerify(e);
        }
        this._pending = null;
        throw new Error(e.message);
      }
    }

    /* ── Try saved session ── */
    const session = loadSession();
    if (session?.serviceToken) {
      const sameUser = !username || !session.username || session.username === username;
      if (sameUser) {
        logger.info('Trying saved session...');
        const cloud = new MiCloud({ country: session.country || country || 'cn', deviceId: DEVICE_ID, logger });
        cloud.restore(session);
        try {
          const devices = this._filter(await cloud.getDevices());
          logger.info('Saved session valid');
          return { devices };
        } catch (e) {
          if (e.authError) { logger.info('Session expired — fresh login'); clearSession(); }
          else throw new Error(e.message);
        }
      }
    }

    /* ── Fresh login ── */
    if (!username || !password) throw new Error('Username and password are required.');
    const creds = { username, password, country: country || 'cn' };
    const cloud = new MiCloud({ ...creds, deviceId: DEVICE_ID, logger });
    try {
      await cloud.login();
      this._pending = null;
      saveSession(cloud, username);
      return { devices: this._filter(await cloud.getDevices()) };
    } catch (e) {
      flog('[server] fresh-login catch: notify=' + !!e.notificationUrl + ' type=' + (e.verifyType||'?') + ' msg=' + e.message?.slice(0,60));
      if (e.notificationUrl) {
        this._pending = { ...creds, cloud };
        const result = this._needVerify(e);
        flog('[server] returning needVerify: ' + JSON.stringify(result).slice(0,120));
        return result;
      }
      this._pending = null;
      flog('[server] rethrowing error: ' + e.message?.slice(0,60));
      throw new Error(e.message);
    }
  }

  _filter(list) {
    const result = list.filter(d => d.localip && d.token);
    flog(`[filter] total=${list.length} passed=${result.length} (need localip+token)`);
    list.forEach(d => flog(`  - ${d.name} model=${d.model} ip=${d.localip||'NO-IP'} token=${d.token?'YES':'NO'}`));
    return result;
  }

  _needVerify(e) {
    return {
      verificationRequired: true,
      verificationUrl:  e.notificationUrl,
      verifyType:       e.verifyType      || 'sts',
      identityFlags:    e.identityFlags   || [],
      identitySession:  e.identitySession || null,
    };
  }
}

(() => new XiaomiMiotUiServer())();
