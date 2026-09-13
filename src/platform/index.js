'use strict';

/**
 * Platform selector: the single swap point for a Windows port.
 * The trigger loop and mods only ever use the returned interface:
 * CHANNELS, getChannelInfo, getCurrentVersion, getWatchPaths,
 * isDiscordRunning, quitDiscord, relaunchDiscord, maxMtimeMs,
 * sendNotification.
 */

function load(platform = process.platform) {
  if (platform === 'win32') {
    return require('./win32');
  }
  return require('./darwin');
}

module.exports = { load };
module.exports.default = load();
