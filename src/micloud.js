'use strict';
/**
 * Xiaomi MiCloud — JavaScript port of hass-xiaomi-miot / xiaomi_cloud.py
 * Follows _login_step1 / _login_step2 / _login_step3 / rc4_params / decrypt_data
 * exactly as in the Python source.
 */

const crypto = require('crypto');
const fetch  = require('node-fetch');
const qslib  = require('querystring');
const urlMod = require('url');

/* ─── constants ──────────────────────────────────────────────────────── */

const AUTH_BASE = 'https://account.xiaomi.com';
const API_BASE  = {
  cn: 'https://api.io.mi.com/app',
  de: 'https://de.api.io.mi.com/app',
  us: 'https://us.api.io.mi.com/app',
  sg: 'https://sg.api.io.mi.com/app',
  ru: 'https://ru.api.io.mi.com/app',
  tw: 'https://tw.api.io.mi.com/app',
  in: 'https://in.api.io.mi.com/app',
  i2: 'https://i2.api.io.mi.com/app',
};

/* ─── helpers ────────────────────────────────────────────────────────── */

function rndStr(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  const buf = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) out += chars[buf[i] % chars.length];
  return out;
}

const USER_AGENT = `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${rndStr(13)} APP/xiaomi.smarthome APPV/62830`;

function md5upper(s) {
  return crypto.createHash('md5').update(s).digest('hex').toUpperCase();
}

function jsonDecode(text) {
  return JSON.parse((text || '').replace(/^&&&START&&&/, ''));
}

/* ─── RC4 (skip-1024) ────────────────────────────────────────────────── */
// Matches: RC4(key).init1024().crypt(data)  in Python utils

function rc4crypt(keyBuf, dataBuf) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + keyBuf[i % keyBuf.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  // skip 1024
  let x = 0, y = 0;
  for (let k = 0; k < 1024; k++) {
    x = (x + 1) & 0xff; y = (y + s[x]) & 0xff; [s[x], s[y]] = [s[y], s[x]];
  }
  const out = Buffer.allocUnsafe(dataBuf.length);
  for (let k = 0; k < dataBuf.length; k++) {
    x = (x + 1) & 0xff; y = (y + s[x]) & 0xff; [s[x], s[y]] = [s[y], s[x]];
    out[k] = dataBuf[k] ^ s[(s[x] + s[y]) & 0xff];
  }
  return out;
}

// signed_nonce(ssecurity, nonce) — matches miutils.signed_nonce
function signedNonce(ssecurity, nonce) {
  return crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from(ssecurity, 'base64'), Buffer.from(nonce, 'base64')]))
    .digest('base64');
}

// gen_nonce() — matches miutils.gen_nonce EXACTLY (8 random bytes + 4 timestamp bytes = 12 bytes)
function genNonce() {
  const ts = Buffer.allocUnsafe(4);
  ts.writeUInt32BE(Math.floor(Date.now() / 60000), 0);
  return Buffer.concat([crypto.randomBytes(8), ts]).toString('base64');
}

// encrypt_data(pwd, data) — matches MiotCloud.encrypt_data
// pwd = signed_nonce (base64 str), data = string
function encryptData(pwd, data) {
  const key = Buffer.from(pwd, 'base64');
  const buf = Buffer.from(String(data), 'utf8');
  return rc4crypt(key, buf).toString('base64');
}

// decrypt_data(pwd, data) — matches MiotCloud.decrypt_data
// pwd = signed_nonce (base64 str), data = base64 str → returns Buffer
function decryptData(pwd, data) {
  const key = Buffer.from(pwd, 'base64');
  const buf = Buffer.from(data, 'base64');
  return rc4crypt(key, buf);
}

// sha1_sign(method, url, dat, nonce) — matches MiotCloud.sha1_sign
// nonce here is signed_nonce (despite param name in Python)
function sha1Sign(method, apiUrl, dat, sNonce) {
  // strip /app/ prefix like Python: if path[:5] == '/app/': path = path[4:]
  const parsed = new urlMod.URL(apiUrl);
  let path = parsed.pathname;
  if (path.startsWith('/app/')) path = path.slice(4);

  const arr = [method.toUpperCase(), path];
  for (const [k, v] of Object.entries(dat)) arr.push(`${k}=${v}`);
  arr.push(sNonce);
  return crypto.createHash('sha1').update(arr.join('&'), 'utf8').digest('base64');
}

/* ─── Simple cookie store (like requests.Session cookies) ─────────────── */

class Cookies {
  constructor() { this._c = {}; }
  update(obj) { Object.assign(this._c, obj); }
  get(name)   { return this._c[name] ?? null; }
  asHeader()  { return Object.entries(this._c).map(([k, v]) => `${k}=${v}`).join('; '); }
  fromSetCookie(headers = []) {
    for (const h of [].concat(headers)) {
      const m = h && h.match(/^([^=]+)=([^;]*)/);
      if (m) this._c[m[1].trim()] = m[2].trim();
    }
  }
}

/* ─── MiCloud ─────────────────────────────────────────────────────────── */

class MiCloud {
  constructor({ username, password, country = 'de', deviceId, logger } = {}) {
    this.username  = username;
    this.password  = password;
    this.country   = country;
    this.deviceId  = deviceId || rndStr(16);
    this.log = logger || { debug: () => {}, info: console.log, warn: console.warn, error: console.error };

    // Session — set after successful login
    this.userId       = null;
    this.ssecurity    = null;
    this.serviceToken = null;   // called service_token in Python
    this.passToken    = null;

    // Persistent across all account requests (like requests.Session cookies)
    this.cookies = new Cookies();

    // Scratch pad (captcha, identity session, verify url, saved auth)
    this.attrs = {};
  }

  /* ── Restore from saved session ── */
  restore(saved) {
    if (!saved?.serviceToken) return false;
    this.userId       = saved.userId       || null;
    this.ssecurity    = saved.ssecurity    || null;
    this.serviceToken = saved.serviceToken;
    this.passToken    = saved.passToken    || null;
    if (saved.country) this.country = saved.country;
    return true;
  }

  /* ── Full login: step1 → step2 → step3 ──────────────────────────────
   *  Matches _login_request(login_data=None) in Python.
   *  Throws with .notificationUrl on security check.
   *  Throws with plain Error on wrong password / captcha.
   */
  async login(loginData = null) {
    this.log.info('[MiCloud] Logging in...');

    // Reset session (like _init_session(True))
    this.serviceToken = null;

    let auth  = this.attrs.loginData || {};   // saved auth from a captcha retry
    let location = '';

    if (!loginData) {
      // Normal flow
      auth = await this._step1();
    } else if (loginData.verifyTicket) {
      // OTP identity verification flow:
      // 1. Send OTP code to Xiaomi API → get verified location
      // 2. Follow location (captures all intermediate cookies)
      // 3. Fresh step1 for new _sign
      // 4. ALWAYS call step2 to get ssecurity (may return STS security check → handled by server)
      const resp = await this._verifyTicket(loginData.verifyTicket);
      location = resp.location || '';
      if (location) {
        await this._followRedirects(location); // capture cookies from full redirect chain
        auth = await this._step1();
        location = ''; // force step2 — ssecurity only comes from step2
        this.log.info(`[login/OTP] after step1: ssecurity=${!!this.ssecurity} → will call step2`);
      }
    } else if (Object.keys(auth).length) {
      // Captcha retry — reuse saved step1 auth
      Object.assign(auth, loginData);
    } else {
      auth = await this._step1();
    }

    if (!location) location = await this._step2(auth);

    const resp = await this._step3(location);
    if (resp.status !== 200) {
      if (resp.status === 403) throw new Error('MiCloud: access denied');
      throw new Error(`MiCloud: login failed (HTTP ${resp.status})`);
    }
    this.log.info(`[MiCloud] Login successful — ssecurity=${!!this.ssecurity} serviceToken=${!!this.serviceToken}`);
  }

  /* ── Get device list — RC4 encrypted ── */
  async getDevices() {
    if (!this.serviceToken) await this.login();

    if (!this.userId || !this.serviceToken) {
      throw Object.assign(new Error('MiCloud: not logged in'), { authError: true });
    }

    const dataObj = { getVirtualModel: true, getHuamiDevices: 1, get_split_device: false, support_smart_home: true };

    // Try configured country first, then major regions (ru added for Caucasus/CIS users)
    // Try all regions. Start with last known-working country (if any) as a performance hint,
    // then fall back through the full list. Stops as soon as a non-empty device list is found.
    const ALL_REGIONS = ['sg', 'cn', 'de', 'us', 'ru', 'tw', 'in', 'i2'];
    const candidates = [...new Set([this.country, ...ALL_REGIONS].filter(Boolean))];

    for (const country of candidates) {
      const apiUrl = (API_BASE[country] || API_BASE.de) + '/home/device_list';

      // Cookie format matching hass-xiaomi-miot async_request_rc4_api → api_cookies() exactly.
      // No sdkVersion, no deviceId — just auth + locale + timezone metadata.
      const tzOffsetMin = -(new Date().getTimezoneOffset()); // positive = east of UTC
      const tzSign = tzOffsetMin >= 0 ? '+' : '-';
      const tzAbs  = Math.abs(tzOffsetMin);
      const timezone = `GMT${tzSign}${String(Math.floor(tzAbs / 60)).padStart(2, '0')}:${String(tzAbs % 60).padStart(2, '0')}`;
      const cookieStr = [
        `userId=${this.userId}`,
        `yetAnotherServiceToken=${this.serviceToken}`,
        `serviceToken=${this.serviceToken}`,
        'locale=en_GB',
        `timezone=${timezone}`,
        'is_daylight=0',
        'dst_offset=0',
        'channel=MI_APP_STORE',
      ].join('; ');

      let parsed = null;

      if (this.ssecurity) {
        // ── RC4 encrypted path ──────────────────────────────────────────────
        const params = { data: JSON.stringify(dataObj) };
        const nonce  = genNonce();
        const sNonce = signedNonce(this.ssecurity, nonce);

        // Build RC4 body
        params['rc4_hash__'] = sha1Sign('POST', apiUrl, params, sNonce);
        const encParams = {};
        for (const [k, v] of Object.entries(params)) {
          encParams[k] = encryptData(sNonce, v);
        }
        encParams['signature'] = sha1Sign('POST', apiUrl, encParams, sNonce);
        encParams['ssecurity'] = this.ssecurity;
        encParams['_nonce']    = nonce;

        const res = await this._fetchSafe(apiUrl, {
          method: 'POST',
          headers: {
            'User-Agent':                 USER_AGENT,
            'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
            'Accept-Encoding':            'identity',
            'Content-Type':               'application/x-www-form-urlencoded',
            'MIOT-ENCRYPT-ALGORITHM':     'ENCRYPT-RC4',
            Cookie:                       cookieStr,
          },
          body: qslib.stringify(encParams),
        });

        const rspText = await res.text();

        // Try RC4 decryption first, fall back to plain JSON parse
        try {
          const dec = decryptData(sNonce, rspText.trim());
          parsed = JSON.parse(dec.toString('utf8'));
        } catch {
          try { parsed = JSON.parse(rspText); } catch { parsed = null; }
        }

        this.log.info(`[getDevices] RC4 ${country}: status=${res.status} code=${parsed?.code} count=${parsed?.result?.list?.length ?? '?'} body=${rspText.slice(0, 120)}`);

        if (!res.ok || parsed?.code === 4 || parsed?.code === -4) {
          this.log.warn(`[getDevices] RC4 auth/region error on ${country}, trying next...`);
          continue;
        }
      } else {
        // ── Plain POST fallback when ssecurity is unavailable ─────────────
        const res = await this._fetchSafe(apiUrl, {
          method: 'POST',
          headers: {
            'User-Agent':                 USER_AGENT,
            'Content-Type':               'application/x-www-form-urlencoded',
            'Accept-Encoding':            'identity',
            'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
            Cookie:                       cookieStr,
          },
          body: qslib.stringify({ data: JSON.stringify(dataObj) }),
        });
        const rspText = await res.text();
        try { parsed = JSON.parse(rspText); } catch { parsed = null; }
        this.log.info(`[getDevices] plain ${country}: status=${res.status} code=${parsed?.code} count=${parsed?.result?.list?.length ?? '?'} body=${rspText.slice(0, 120)}`);
        if (!res.ok || parsed?.code === 4 || parsed?.code === -4) {
          this.log.warn(`[getDevices] plain auth/region error on ${country}, trying next...`);
          continue;
        }
      }

      if (!parsed || (parsed.code !== 0 && !parsed.result)) {
        const err = new Error(`MiCloud API error (code=${parsed?.code})`);
        err.authError = true;
        throw err;
      }

      const list = (parsed?.result?.list || []).map(d => ({
        did: d.did, name: d.name, model: d.model,
        localip: d.localip, token: d.token, mac: d.mac,
      }));

      // If this region returned 0 devices, try next region — devices may be in a different server.
      if (!list.length) {
        this.log.warn(`[getDevices] ${country}: code=0 but 0 devices — trying next region...`);
        continue;
      }

      // Success — remember the working country
      this.country = country;
      this.log.info(`[getDevices] working server: ${country}`);
      return list;
    }

    const err = new Error('MiCloud API error: no working server found (tried all regions)');
    err.authError = true;
    throw err;
  }

  /* ──────────────────────────────────────────────────────────────────── *
   *  PRIVATE — login steps                                               *
   * ──────────────────────────────────────────────────────────────────── */

  // _login_step1
  async _step1() {
    this.cookies.update({ sdkVersion: '3.8.6', deviceId: this.deviceId });
    const data = await this._accountGet('/pass/serviceLogin', {
      params: { sid: 'xiaomiio', _json: 'true' },
    });
    this.log.info(`[step1] code=${data?.code} sign=${!!data?._sign} location=${!!data?.location} ssecurity=${!!data?.ssecurity}`);
    if (data?.code === 0) {
      if (data.userId)    this.userId    = String(data.userId);
      if (data.ssecurity) this.ssecurity = data.ssecurity;
      if (data.passToken) this.passToken = data.passToken;
    }
    return data || {};
  }

  // _login_step2
  async _step2(kwargs = {}) {
    const post = {
      user:     this.username,
      hash:     md5upper(this.password),
      // Fallback to STS callback — matches base micloud Python library
      callback: kwargs.callback || 'https://sts.api.io.mi.com/sts',
      sid:      kwargs.sid      || 'xiaomiio',
      qs:       kwargs.qs       || '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      _sign:    kwargs._sign    || '',
    };
    const extraParams = { _json: 'true' };
    const extraCookies = {};

    if (kwargs.captcha) {
      post.captCode = kwargs.captcha;
      extraParams._dc = Date.now();
      extraCookies.ick = this.attrs.captchaIck || '';
    }

    const data = await this._accountPost('/pass/serviceLoginAuth2', {
      data: post, params: extraParams, cookies: extraCookies,
    });
    this.log.info(`[step2] code=${data?.code} location=${!!data?.location} notify=${!!data?.notificationUrl} captcha=${!!data?.captchaUrl} ssecurity=${!!data?.ssecurity}`);

    const location = data?.location;
    if (!location) {
      // notificationUrl → security check
      if (data?.notificationUrl) {
        let ntf = data.notificationUrl;
        if (!ntf.startsWith('http')) ntf = AUTH_BASE + ntf;
        this.attrs.verifyUrl = ntf;

        const err = new Error('Xiaomi security check required');
        err.notificationUrl = ntf;
        if (ntf.includes('identity/authStart')) {
          // Fire identity/list in background to set up identity_session cookie
          // before user enters the code. Don't await — must not block discover.
          this.attrs._identityListPromise = this._identityList(ntf).catch(() => null);
          err.verifyType = 'identity';
        } else {
          err.verifyType = 'sts';
        }
        throw err;
      }

      // captchaUrl
      if (data?.captchaUrl) {
        let cap = data.captchaUrl;
        if (!cap.startsWith('http')) cap = AUTH_BASE + cap;
        const ick = await this._getCaptcha(cap);
        if (ick) this.attrs.loginData = kwargs;
        const err = new Error(`Xiaomi requires CAPTCHA — too many failed attempts. Wait a few minutes or log in at account.xiaomi.com first.`);
        err.captchaRequired = true;
        throw err;
      }

      throw new Error(`Login failed (code=${data?.code}, desc=${data?.description || ''})`);
    }

    // Success
    this.userId    = String(data.userId || '');
    this.ssecurity = data.ssecurity || null;
    this.passToken = data.passToken || null;
    if (data.serviceToken) {
      this.serviceToken = data.serviceToken;
      this.log.info(`[step2] serviceToken captured from auth response`);
    }
    this.log.info(`[step2] SUCCESS — ssecurity=${!!this.ssecurity} serviceToken=${!!this.serviceToken}`);
    return location;
  }

  // _login_step3
  async _step3(location) {
    // Follow ALL redirects (like Python requests.Session) so every hop's
    // Set-Cookie is captured — serviceToken may arrive mid-chain.
    const resp = await this._accountGetRaw(location, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      allowRedirects: true,
    });
    // _followRedirects already called fromSetCookie at each hop;
    // call once more for the final response just in case.
    const setCookies = resp.headers.raw()['set-cookie'] || [];
    this.cookies.fromSetCookie(setCookies);

    const serviceToken = this.cookies.get('serviceToken');
    if (serviceToken) {
      this.serviceToken = serviceToken;
      const uid = this.cookies.get('userId');
      if (uid) this.userId = uid;
      this.log.info(`[step3] serviceToken obtained (cookies: ${this.cookies.asHeader().slice(0, 120)})`);
    } else {
      throw new Error(`step3: no serviceToken in response (status=${resp.status})`);
    }
    return resp;
  }

  /* ── RC4 API call — matches async_request_rc4_api ─────────────────── */
  async _requestRc4Api(endpoint, params) {
    const apiUrl = (API_BASE[this.country] || API_BASE.de) + '/' + endpoint;

    if (!this.ssecurity) {
      this.log.warn('[MiCloud] ssecurity is null — cannot make encrypted API call');
      throw Object.assign(new Error('MiCloud: ssecurity not available — please log in again'), { authError: true });
    }

    const nonce  = genNonce();
    const sNonce = signedNonce(this.ssecurity, nonce);

    // rc4_params: add rc4_hash__, encrypt all, add signature+ssecurity+_nonce
    params['rc4_hash__'] = sha1Sign('POST', apiUrl, params, sNonce);
    const encParams = {};
    for (const [k, v] of Object.entries(params)) {
      encParams[k] = encryptData(sNonce, v);
    }
    encParams['signature'] = sha1Sign('POST', apiUrl, encParams, sNonce);
    encParams['ssecurity'] = this.ssecurity;
    encParams['_nonce']    = nonce;

    const cookieStr = [
      `userId=${this.userId}`,
      `yetAnotherServiceToken=${this.serviceToken}`,
      `serviceToken=${this.serviceToken}`,
      'locale=en_GB',
      'channel=MI_APP_STORE',
      `PassportDeviceId=${this.deviceId}`,
    ].join('; ');

    const res = await this._fetchSafe(apiUrl, {
      method: 'POST',
      headers: {
        'User-Agent':                  USER_AGENT,
        'Content-Type':                'application/x-www-form-urlencoded',
        'MIOT-ENCRYPT-ALGORITHM':      'ENCRYPT-RC4',
        'Accept-Encoding':             'identity',
        'x-xiaomi-protocal-flag-cli':  'PROTOCAL-HTTP2',
        Cookie: cookieStr,
      },
      body: qslib.stringify(encParams),
    });

    const rsp = await res.text();

    // Decrypt response — matches Python: elif 'message' not in rsp: decrypt
    if (!rsp || rsp.includes('error') || rsp.includes('invalid')) {
      this.log.warn(`[api] unusual response: ${rsp?.slice(0, 100)}`);
      return rsp;
    }
    if (rsp.includes('message')) {
      // plain JSON error response
      try { return JSON.parse(rsp); } catch { return rsp; }
    }
    try {
      const decrypted = decryptData(sNonce, rsp.trim());
      return decrypted.toString('utf8');
    } catch {
      return rsp;
    }
  }

  /* ── Account request helpers (like account_post / account_get) ──────── */

  _fetchOpts(extra = {}) {
    // AbortController-based 20s timeout for all account/API requests
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    return { signal: ctrl.signal, _clear: () => clearTimeout(timer), ...extra };
  }

  async _fetchSafe(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async _accountGet(path, { params = {}, headers = {} } = {}) {
    const fullUrl = path.startsWith('http') ? path : AUTH_BASE + path;
    const qStr = qslib.stringify(params);
    const reqUrl = qStr ? `${fullUrl}?${qStr}` : fullUrl;
    const res = await this._fetchSafe(reqUrl, {
      headers: { 'User-Agent': USER_AGENT, Cookie: this.cookies.asHeader(), ...headers },
      redirect: 'manual',
    });
    this.cookies.fromSetCookie(res.headers.raw()['set-cookie']);
    try { return jsonDecode(await res.text()); } catch { return {}; }
  }

  async _accountGetRaw(path, { headers = {}, allowRedirects = false } = {}) {
    const fullUrl = path.startsWith('http') ? path : AUTH_BASE + path;
    if (!allowRedirects) {
      const res = await this._fetchSafe(fullUrl, {
        headers: { 'User-Agent': USER_AGENT, Cookie: this.cookies.asHeader(), ...headers },
        redirect: 'manual',
      });
      this.cookies.fromSetCookie(res.headers.raw()['set-cookie']);
      return res;
    }
    // Manually follow redirects — capture cookies at EVERY step (like requests.Session)
    return this._followRedirects(fullUrl, headers);
  }

  async _followRedirects(startUrl, extraHeaders = {}, maxHops = 10) {
    let url = startUrl;
    let res;
    for (let i = 0; i < maxHops; i++) {
      res = await this._fetchSafe(url, {
        headers: { 'User-Agent': USER_AGENT, Cookie: this.cookies.asHeader(), ...extraHeaders },
        redirect: 'manual',
      });
      // Capture cookies from this hop
      this.cookies.fromSetCookie(res.headers.raw()['set-cookie']);
      const loc = res.headers.get('location');
      if ((res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307) && loc) {
        url = loc.startsWith('http') ? loc : new urlMod.URL(loc, url).href;
        this.log.info(`[redirect] ${res.status} → ${url.slice(0, 80)}`);
      } else {
        break; // not a redirect
      }
    }
    return res;
  }

  async _accountPost(path, { data = {}, params = {}, cookies = {} } = {}) {
    const fullUrl = path.startsWith('http') ? path : AUTH_BASE + path;
    const qStr = qslib.stringify(params);
    const reqUrl = qStr ? `${fullUrl}?${qStr}` : fullUrl;
    const extraCookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const cookieStr = [this.cookies.asHeader(), extraCookieStr].filter(Boolean).join('; ');
    const res = await this._fetchSafe(reqUrl, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieStr,
      },
      body: qslib.stringify(data),
      redirect: 'manual',
    });
    this.cookies.fromSetCookie(res.headers.raw()['set-cookie']);
    try { return jsonDecode(await res.text()); } catch { return {}; }
  }

  /* ── Identity verification helpers ───────────────────────────────────── */

  // check_identity_list
  async _identityList(notifyUrl) {
    const listUrl = notifyUrl.replace('fe/service/identity/authStart', 'identity/list');
    const res = await this._fetchSafe(listUrl, {
      headers: { 'User-Agent': USER_AGENT, Cookie: this.cookies.asHeader() },
      redirect: 'manual',
    });
    this.cookies.fromSetCookie(res.headers.raw()['set-cookie']);
    const session = this.cookies.get('identity_session') || null;
    let flags = [4]; // default: phone
    try {
      const d = jsonDecode(await res.text());
      flags = d?.options || [d?.flag || 4];
    } catch {}
    return { flags, session };
  }

  // verify_ticket(ticket) — ticket is the 6-digit SMS/email code
  async _verifyTicket(ticket) {
    const ntf = this.attrs.verifyUrl;
    if (!ntf) return {};

    // Await the background identity/list promise started in step2
    // (gives us identity_session cookie and available verification methods)
    let flags = [4, 8]; // fallback: try phone then email
    let session = this.cookies.get('identity_session');
    if (this.attrs._identityListPromise) {
      const result = await this.attrs._identityListPromise.catch(() => null);
      if (result) { flags = result.flags; session = result.session || session; }
      delete this.attrs._identityListPromise;
    }

    this.log.info(`[_verifyTicket] flags=${JSON.stringify(flags)} session=${!!session}`);

    for (const flag of flags) {
      const api = { 4: '/identity/auth/verifyPhone', 8: '/identity/auth/verifyEmail' }[flag];
      if (!api) continue;
      const data = await this._accountPost(api, {
        params: { _dc: Date.now() },
        data: { _flag: flag, ticket, trust: 'true', _json: 'true' },
        cookies: { identity_session: session || '' },
      });
      this.log.info(`[_verifyTicket] flag=${flag} code=${data?.code} keys=${Object.keys(data||{}).join(',')}`);
      if (data?.code === 0) {
        // Extract auth fields — verifyPhone/Email returns same fields as step2
        if (data.userId)    this.userId    = String(data.userId);
        if (data.ssecurity) this.ssecurity = data.ssecurity;
        if (data.passToken) this.passToken = data.passToken;
        return data; // has .location
      }
    }
    return {};
  }

  // _get_captcha
  async _getCaptcha(capUrl) {
    const res = await fetch(capUrl, { headers: { 'User-Agent': USER_AGENT } });
    this.cookies.fromSetCookie(res.headers.raw()['set-cookie']);
    const ick = this.cookies.get('ick');
    if (ick) {
      this.attrs.captchaIck = ick;
      this.attrs.captchaImg = (await res.buffer()).toString('base64');
    }
    return ick;
  }
}

module.exports = MiCloud;
