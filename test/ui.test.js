'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ui = require('../src/ui');

describe('ui', () => {
  it('header box frames title + subtitle with rounded corners', () => {
    const out = ui.headerBox('Autocord (@fastdemo)', 'macOS · Vencord Auto-Patcher', { color: false });
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = stripped.split('\n');
    assert.ok(lines[0].startsWith('╭') && lines[0].endsWith('╮'));
    assert.ok(lines[lines.length - 1].startsWith('╰') && lines[lines.length - 1].endsWith('╯'));
    assert.ok(stripped.includes('Autocord (@fastdemo)'));
    assert.ok(stripped.includes('macOS · Vencord Auto-Patcher'));
    const widths = new Set(lines.map((l) => [...l].length));
    assert.equal(widths.size, 1, 'all box lines equal width');
  });

  it('title is always the literal handle, no version', () => {
    assert.equal(ui.title(), 'Autocord (@fastdemo)');
  });

  it('border carries the Mocha Teal tint when colored, bare lines when not', () => {
    const colored = ui.headerBox('T', null, { color: true });
    assert.ok(colored.includes('\x1b[38;2;148;226;213m╭'), 'tinted top-left corner');
    const plain = ui.headerBox('T', null, { color: false });
    assert.ok(!plain.includes('\x1b'), 'no codes when disabled');
    assert.equal(
      plain.replace(/\x1b\[[0-9;]*m/g, ''),
      colored.replace(/\x1b\[[0-9;]*m/g, ''),
      'same geometry with and without color'
    );
  });

  it('Catppuccin Mocha values are emitted as truecolor', () => {
    const o = { color: true };
    assert.ok(ui.dim('x', o).includes('\x1b[38;2;108;112;134m'), 'Overlay0 muted');
    assert.ok(ui.sky('x', o).includes('\x1b[38;2;137;220;235m'), 'Sky highlight');
    assert.ok(ui.mint('x', o).includes('\x1b[38;2;166;227;161m'), 'Green success');
    assert.ok(ui.yellow('x', o).includes('\x1b[38;2;249;226;175m'), 'Yellow progress');
    assert.ok(ui.red('x', o).includes('\x1b[38;2;243;139;168m'), 'Red failure');
    assert.ok(ui.bold('x', o).includes('\x1b[38;2;205;214;244m'), 'Text bright value');
  });

  it('kv rows align values into one column and brighten them', () => {
    const out = ui.kvRows([['channel', 'ptb'], ['patched version', '0.0.260']], { color: true });
    const [a, b] = out.split('\n');
    assert.equal(
      a.replace(/\x1b\[[0-9;]*m/g, '').indexOf('ptb'),
      b.replace(/\x1b\[[0-9;]*m/g, '').indexOf('0.0.260')
    );
    assert.ok(out.includes('\x1b[1m\x1b[38;2;205;214;244mptb'), 'values are bold Mocha Text');
  });

  it('dots carry color codes when enabled, bare ● when not', () => {
    assert.ok(ui.dot('green', { color: true }).includes('●'));
    assert.ok(ui.dot('green', { color: true }).includes('\x1b['));
    assert.ok(ui.dot('yellow', { color: true }).includes('\x1b['));
    assert.ok(ui.dot('red', { color: true }).includes('\x1b['));
    assert.equal(ui.dot('green', { color: false }), '●');
  });

  it('mint/yellow/red painters emit codes when enabled', () => {
    assert.ok(ui.mint('x', { color: true }).includes('\x1b['));
    assert.ok(ui.yellow('x', { color: true }).includes('\x1b['));
    assert.ok(ui.red('x', { color: true }).includes('\x1b['));
    assert.equal(ui.mint('x', { color: false }), 'x');
  });

  it('output is plain when piped, styled when forced or opted in', () => {
    assert.equal(ui.dot('green'), '●');
    assert.ok(!ui.bold('x').includes('\x1b'));
    assert.ok(!ui.headerBox('T', 'S').includes('\x1b'));
    assert.ok(ui.dot('green', { color: true }).includes('\x1b['));
    process.env.FORCE_COLOR = '1';
    try {
      assert.ok(ui.dot('green').includes('\x1b['));
    } finally {
      delete process.env.FORCE_COLOR;
    }
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '1';
    try {
      assert.ok(ui.dot('green').includes('\x1b['), 'FORCE_COLOR wins for explicit opt-out env');
    } finally {
      delete process.env.NO_COLOR;
      delete process.env.FORCE_COLOR;
    }
  });

  it('status lines keep label/dot/message shape without color', () => {
    const out = ui.statusLine('ptb', 'green', 'Patched', { color: false });
    assert.match(out, /^ptb\s+● Patched$/);
  });

  it('subtitle switches for betterdiscord dry-run', () => {
    assert.match(ui.subtitleForMod('betterdiscord'), /dry-run/);
    assert.ok(!/dry-run/.test(ui.subtitleForMod('vencord')));
  });
});
