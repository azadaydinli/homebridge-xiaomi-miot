'use strict';

const crypto  = require('crypto');
const fetch   = require('node-fetch');
const url     = require('url');

const API_BASE = {
  cn: 'https://api.io.mi.com/app',
  de: 'https://de.api.io.mi.com/app',
  us: 'https://us.api.io.mi.com/app',
  sg: 'https://sg.api.io.mi.com/app',
  ru: 'https://ru.api.io.mi.com/app',
  tw: 'https://tw.api.io.mi.com/app',
  in: 'https://in.api.io.mi.com/app',
  i2: 'https://i2.api.io.mi.com/app',
};

const AUTH_BASE  = 'https://account.xiaomi.com';

function _rndStr(n) {
  return crypto.randomBytes(n).toString('hex').slice(0, n).toUpperCase();
}

const USER_AGENT = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-' + _rndStr(13) + ' APP/xiaomi.smarthome/62830';

class CookieJar {
  constructor() { this._cookies = {}; }
  set(name, value, domain) { this._cookies[`${domain}:${name}`] = value; }
  get(domain) {
    return Object.entries(this._cookies)
      .filter(([k]) => k.startsWith(domain + ':'))
      .map(([k, v]) => `${k.split(':')[1]}=${v}`)
      .join('; ');
  }
  fromHeader(domain, headers = []) {
    for (const h of [].concat(headers)) {
      const m = h.match(/^([^=]+)=([^;]*)/);
      if (m) this.set(m[1].trim(), m[2].trim(), domain);
    }
  }
  value(name) {
    for (const [k, v] of Object.entries(this._cookies))
      if (k.endsWith(':' + name)) return v;
    return null;
  }
}

function rc4Skip1024(key, data) {
  const keyBuf  = Buffer.isBuffer(key)  ? key  : Buffer.from(key);
  const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + keyBuf[i % keyBuf.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let x = 0, y = 0;
  for (let k = 0; k < 1024; k++) {
    x = (x + 1) & 0xff; y = (y + s[x]) & 0xff;
    [s[x], s[y]] = [s[y], s[x]];
  }
  const out = Buffer.allocUnsafe(dataBuf.length);
  for (let k = 0; k < dataBuf.length; k++) {
    x = (x + 1) & 0xff; y = (y + s[x]) & 0xff;
    [s[x], s[y]] = [s[y], s[x]];
    out[k] = dataBuf[k] ^ s[(s[x] + s[y]) & 0xff];
  }
  return out;
}

class MiCloud {
  constructor({ username, password, country = 'de', logger } = {}) {
    this.username      = username;
    this.password      = password;
    this.country       = country;
    this.logger        = logger || { debug: () => {}, info: console.log, warn: console.warn, error: console.error };
    this._jar          = new CookieJar();
    this._userId       = null;
    this._ssecurity    = null;
    this._serviceToken = null;
    this._loggedIn     = false;
  }

  async login() {
    this.logger.info('[MiCloud] Logging in...');
    const step1 = await this._step1();
    if (!step1) throw new Error('MiCloud login step 1 failed');
    const step2 = await this._step2(step1);
    if (!step2 || !step2.location) throw new Error('MiCloud login failed — check username/password');
    await this._step3(step2.location);
    if (!this._serviceToken) throw new Error('MiCloud login failed — no service token received');
    this._loggedIn = true;
    this.logger.info('[MiCloud] Login successful');
  }

  async getDevices() {
    if (!this._loggedIn) await this.login();
    const res = await this._apiCall('home/device_list', {
      getVirtualModel: true, getHuamiDevices: 1,
      get_split_device: false, support_smart_home: true,
    });
    return (res && res.result && res.result.list ? res.result.list : []).map(d => ({
      did: d.did, name: d.name, model: d.model,
      localip: d.localip, token: d.token, mac: d.mac,
    }));
  }

  getSession() {
    return { userId: this._userId, ssecurity: this._ssecurity,
             serviceToken: this._serviceToken, country: this.country,
             loggedInAt: new Date().toISOString() };
  }

  restoreSession(s) {
    if (!s || !s.serviceToken) return false;
    this._userId = s.userId; this._ssecurity = s.ssecurity;
    this._serviceToken = s.serviceToken; this.country = s.country || this.country;
    this._loggedIn = true;
    this.logger.debug('[MiCloud] Session restored');
    return true;
  }

  async _step1() {
    const res = await fetch(`${AUTH_BASE}/pass/serviceLogin?sid=xiaomiio&_json=true`, {
      headers: { 'User-Agent': USER_AGENT,
        Cookie: `sdkVersion=3.8.6; deviceId=${_rndStr(16)}` },
      redirect: 'manual',
    });
    this._jar.fromHeader('account.xiaomi.com', res.headers.raw()['set-cookie']);
    const text = (await res.text()).replace(/^&&&START&&&/, '');
    try { return JSON.parse(text); } catch { return null; }
  }

  async _step2({ _sign, qs, callback, sid }) {
    const hash = crypto.createHash('md5').update(this.password).digest('hex').toUpperCase();
    const body = new url.URLSearchParams({ user: this.username, hash, callback, sid, qs, _sign, _json: 'true' });
    const res = await fetch(`${AUTH_BASE}/pass/serviceLoginAuth2?_json=true`, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this._jar.get('account.xiaomi.com') },
      body: body.toString(), redirect: 'manual',
    });
    this._jar.fromHeader('account.xiaomi.com', res.headers.raw()['set-cookie']);
    const text = (await res.text()).replace(/^&&&START&&&/, '');
    try {
      const data = JSON.parse(text);
      if (data.code === 70016) throw new Error('MiCloud: wrong password');
      if (data.code === 81003) throw new Error('MiCloud: 2FA required — not supported');
      this._userId = String(data.userId); this._ssecurity = data.ssecurity;
      return data;
    } catch(e) { if (e.message && e.message.startsWith('MiCloud:')) throw e; return null; }
  }

  async _step3(location) {
    const domain = this.country === 'cn' ? 'api.io.mi.com' : `${this.country}.api.io.mi.com`;
    const res = await fetch(location, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual' });
    this._jar.fromHeader('mi.com', res.headers.raw()['set-cookie']);
    this._jar.fromHeader(domain,   res.headers.raw()['set-cookie']);
    this._serviceToken = this._jar.value('serviceToken');
    if (!this._serviceToken) {
      const loc2 = res.headers.get('location');
      if (loc2) {
        const r2 = await fetch(loc2, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual' });
        this._jar.fromHeader('mi.com', r2.headers.raw()['set-cookie']);
        this._serviceToken = this._jar.value('serviceToken');
      }
    }
  }

  async _apiCall(endpoint, params = {}) {
    const base  = API_BASE[this.country] || API_BASE.de;
    const path  = `/${endpoint}`;
    const nonce = this._nonce();
    const signedNonce = this._signedNonce(nonce);
    const encParams   = this._encryptParams(params, signedNonce);
    const signature   = this._signature('POST', path, encParams, signedNonce);
    const domain = this.country === 'cn' ? 'api.io.mi.com' : `${this.country}.api.io.mi.com`;
    const body = new url.URLSearchParams({ ...encParams, signature, ssecurity: this._ssecurity, _nonce: nonce });
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
        Cookie: `userId=${this._userId}; serviceToken=${this._serviceToken}; locale=en_GB` },
      body: body.toString(),
    });
    const text = (await res.text()).replace(/^&&&START&&&/, '');
    try { return JSON.parse(text); } catch { return null; }
  }

  _nonce() {
    const rand = crypto.randomBytes(4);
    const ts = Buffer.allocUnsafe(4);
    ts.writeInt32BE(Math.floor(Date.now() / 1000 / 60), 0);
    return Buffer.concat([rand, ts]).toString('base64');
  }

  _signedNonce(nonce) {
    const s = Buffer.from(this._ssecurity, 'base64');
    const n = Buffer.from(nonce, 'base64');
    return crypto.createHash('sha256').update(Buffer.concat([s, n])).digest('base64');
  }

  _encryptParams(params, signedNonce) {
    const key = Buffer.from(signedNonce, 'base64');
    const enc = {};
    for (const [k, v] of Object.entries(params)) {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      enc[k] = rc4Skip1024(key, Buffer.from(val, 'utf8')).toString('base64');
    }
    return enc;
  }

  _signature(method, path, encParams, signedNonce) {
    const pairs = Object.entries(encParams).map(([k, v]) => `${k}=${v}`).join('&');
    return crypto.createHash('sha1').update([method, path, pairs, signedNonce].join('\n')).digest('base64');
  }
}

module.exports = MiCloud;
