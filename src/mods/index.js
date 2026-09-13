'use strict';

/**
 * Mod-target registry. Adding BetterDiscord later = add src/mods/betterdiscord.js
 * implementing { name, detect_install, is_patched, patch, unpatch } and require
 * it here. Nothing else changes.
 */

const vencord = require('./vencord');
const betterdiscord = require('./betterdiscord');

const MODS = {
  [vencord.name]: vencord,
  [betterdiscord.name]: betterdiscord,
};

function getMod(name) {
  const mod = MODS[name];
  if (!mod) throw new Error(`Unknown mod "${name}". Available: ${Object.keys(MODS).join(', ')}`);
  return mod;
}

module.exports = { MODS, getMod };
