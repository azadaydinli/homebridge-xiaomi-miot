'use strict';

const path    = require('path');
const MiCloud = require(path.join(__dirname, '../src/micloud.js'));

module.exports = (api) => {

  api.onRequest('/discover', async (body) => {
    const { username, password, country } = body || {};
    if (!username || !password) {
      throw new Error('Username and password are required.');
    }

    const cloud = new MiCloud({
      username,
      password,
      country: country || 'cn',
      logger: {
        debug: (...a) => api.log.debug(...a),
        info:  (...a) => api.log.info(...a),
        warn:  (...a) => api.log.warn(...a),
        error: (...a) => api.log.error(...a),
      },
    });

    await cloud.login();
    const devices = await cloud.getDevices();

    // Only return devices that have both a local IP and a token
    const usable = devices.filter(d => d.localip && d.token);
    return { devices: usable };
  });

};
