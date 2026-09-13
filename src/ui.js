'use strict';

/**
 * Minimal terminal styling in the TorCode reference language. Zero
 * dependencies, hand-rolled box-drawing + ANSI in Catppuccin Mocha
 * (matched to the reference exactly — see palette below).
 *
 * Header box only; everywhere else is flat monospace with one blank line
 * between sections. Icons: ● state dots, → transitions, · muted separators.
 *
 * Monochrome unless enabled: explicit { color: true }, a TTY without
 * NO_COLOR, or FORCE_COLOR=1.
 */

/**
 * Catppuccin Mocha, exactly (matched to the TorCode reference):
 *   text #cdd6f4 · muted Overlay0 #6c7086 · border Teal #94e2d5
 *   highlighted values Sky #89dceb · success Green #a6e3a1
 *   in-progress Yellow #f9e2af · failure Red #f38ba8
 * Emitted as truecolor ANSI.
 */
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  text: '\x1b[38;2;205;214;244m',
  edge: '\x1b[38;2;148;226;213m', // Mocha Teal header border
  muted: '\x1b[38;2;108;112;134m', // Mocha Overlay0 secondary text
  sky: '\x1b[38;2;137;220;235m', // Mocha Sky highlighted values/links
  mint: '\x1b[38;2;166;227;161m', // Mocha Green success words
  yellow: '\x1b[38;2;249;226;175m', // Mocha Yellow in-progress
  green: '\x1b[38;2;166;227;161m', // Mocha Green state dots
  red: '\x1b[38;2;243;139;168m', // Mocha Red failures
};

function useColor(opts = {}) {
  if (opts.color === true) return true;
  if (opts.color === false) return false;
  const force = process.env.FORCE_COLOR ?? process.env.CLICOLOR_FORCE;
  if (force !== undefined && force !== '' && force !== '0' && String(force).toLowerCase() !== 'false') return true;
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

function paint(code, text, opts) {
  return useColor(opts) ? `${code}${text}${C.reset}` : String(text);
}

const bold = (t, o) => paint(`${C.bold}${C.text}`, t, o); // bright values/titles
const dim = (t, o) => paint(C.muted, t, o); // "dim" = reference muted gray
const sky = (t, o) => paint(C.sky, t, o); // highlighted values/links
const mint = (t, o) => paint(C.mint, t, o);
const yellow = (t, o) => paint(C.yellow, t, o);
const red = (t, o) => paint(C.red, t, o);

function dot(colorName, opts) {
  const codes = { green: C.green, yellow: C.yellow, red: C.red, mint: C.mint };
  return paint(codes[colorName] || '', '●', opts);
}

const ARROW = '→';
const BULLET = '·';

function visibleWidth(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Header box. Title: bold first line ("Autocord (@fastdemo)" — no version);
 * subtitle: muted second line. Sage-tinted rounded border like the reference.
 */
function headerBox(title, subtitle, opts = {}) {
  const edge = (s) => paint(C.edge, s, opts);
  const pad = 2;
  const inner = Math.max(visibleWidth(title), visibleWidth(subtitle || '')) + pad * 2;
  const line = (content) => {
    const gap = ' '.repeat(Math.max(0, inner - visibleWidth(content)));
    return `${edge('│')}${content}${gap}${edge('│')}`;
  };
  const top = `${edge('╭')}${edge('─'.repeat(inner))}${edge('╮')}`;
  const bottom = `${edge('╰')}${edge('─'.repeat(inner))}${edge('╯')}`;
  const rows = [top, line(`  ${bold(title, opts)}`)];
  if (subtitle) rows.push(line(`  ${dim(subtitle, opts)}`));
  rows.push(bottom);
  return rows.join('\n');
}

/** Aligned key/value rows: muted labels padded equal, BRIGHT values. */
function kvRows(pairs, opts = {}) {
  const width = Math.max(...pairs.map(([k]) => visibleWidth(k)));
  return pairs
    .map(([k, v]) => `${dim(String(k).padEnd(width), opts)}  ${bold(v, opts)}`)
    .join('\n');
}

/** Status line: muted label column + colored dot + message. */
function statusLine(label, dotColor, message, opts = {}) {
  const labelWidth = 9;
  return `${dim(String(label).padEnd(labelWidth), opts)}  ${dot(dotColor, opts)} ${message}`;
}

function version() {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
}

/** Identity slot, mirroring the reference exactly: always @fastdemo, no version. */
const HANDLE = '@fastdemo';

function title() {
  return `Autocord (${HANDLE})`;
}

const SUBTITLE_VENCORD = 'macOS · Vencord Auto-Patcher';
const SUBTITLE_BETTERDISCORD = 'macOS · BetterDiscord · dry-run mode';

function subtitleForMod(mod) {
  return mod === 'betterdiscord' ? SUBTITLE_BETTERDISCORD : SUBTITLE_VENCORD;
}

function appHeader(mod, opts = {}) {
  return headerBox(title(), subtitleForMod(mod), opts);
}

module.exports = {
  useColor,
  bold,
  dim,
  sky,
  mint,
  yellow,
  red,
  dot,
  ARROW,
  BULLET,
  headerBox,
  kvRows,
  statusLine,
  version,
  HANDLE,
  title,
  appHeader,
  subtitleForMod,
  SUBTITLE_VENCORD,
  SUBTITLE_BETTERDISCORD,
};
