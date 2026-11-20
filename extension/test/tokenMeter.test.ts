import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meterReport } from '../src/core';
import { bar, savedPercent, shortCount, tokenMeter } from '../src/tokenMeter';

/** Filled cells of a bar, by colour variable. */
const cells = (html: string) => Object.fromEntries(
  [...html.matchAll(/<span style="color:var\((--vscode-[\w-]+)\);">(█+)<\/span>/g)].map((m) => [m[1], m[2].length]),
);

test('short counts for the status bar', () => {
  assert.equal(shortCount(0), '0');
  assert.equal(shortCount(999), '999');
  assert.equal(shortCount(1000), '1k');
  assert.equal(shortCount(6312), '6.3k');
  assert.equal(shortCount(123456), '123k');
});

test('saved percent is rounded and negative when the view is larger', () => {
  assert.equal(savedPercent(2104, 6312), 67);
  assert.equal(savedPercent(120, 100), -20);
  assert.equal(savedPercent(5, 0), 0, 'an empty file saves nothing');
});

test('bars use only the styles hovers allow', () => {
  const html = bar(6, 24, '--vscode-charts-green');
  assert.deepEqual(cells(html), { '--vscode-charts-green': 6, '--vscode-editorWidget-border': 18 });
  // VS Code's hover sanitizer keeps a span style only when it matches this pattern.
  for (const [, style] of html.matchAll(/style="([^"]*)"/g)) {
    assert.match(style, /^(color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?$/);
  }
  assert.deepEqual(cells(bar(1, 10_000, '--vscode-charts-red')), { '--vscode-charts-red': 1, '--vscode-editorWidget-border': 23 }, 'a tiny value still shows');
  assert.deepEqual(cells(bar(0, 0, '--vscode-charts-red')), { '--vscode-editorWidget-border': 24 });
});

test('the meter compares the raw file with the agent and brief views', () => {
  const meter = tokenMeter({ raw: 6312, agent: 2104, brief: 1204 });
  assert.equal(meter.text, '$(hubot) 6.3k → 2.1k tok');
  assert.match(meter.tooltip, /### 67% fewer tokens with smd/);
  assert.match(meter.tooltip, /Without smd · raw file &nbsp; \*\*≈6,312\*\* tok/);
  assert.match(meter.tooltip, /With smd · agent view &nbsp; \*\*≈2,104\*\* tok · \*\*67%\*\* fewer/);
  assert.match(meter.tooltip, /With smd · brief view &nbsp; \*\*≈1,204\*\* tok · \*\*81%\*\* fewer/);
  // The raw file fills its bar; the views are drawn to the same scale.
  const bars = meter.tooltip.split('\n').filter((l) => l.includes('█')).map(cells);
  assert.deepEqual(bars.map((b) => Object.values(b)[0]), [24, 8, 5]);
});

test('every link in the card runs a trusted command', () => {
  const meter = tokenMeter({ raw: 100, agent: 50, brief: 25 });
  const linked = [...meter.tooltip.matchAll(/\]\(command:([\w.]+)/g)].map((m) => m[1]);
  assert.deepEqual(linked, meter.commands);
  assert.deepEqual(meter.commands, ['smd.showAgentView', 'smd.showAgentViewBrief', 'smd.showAgentViewOmissions', 'smd.copyAgentView']);
});

test('an agent view larger than the file says so', () => {
  const meter = tokenMeter({ raw: 100, agent: 150, brief: 100 });
  assert.match(meter.tooltip, /### 50% more tokens with smd/);
  assert.match(meter.tooltip, /agent view &nbsp; \*\*≈150\*\* tok · 50% more \(includes\)/);
  assert.doesNotMatch(meter.tooltip, /brief view[^\n]*·/, 'no note when the brief view is the same size');
});

test('with metering off the card offers to turn it on; with no workspace it does not', () => {
  const off = tokenMeter({ raw: 100, agent: 50, brief: 25, metering: false });
  assert.match(off.tooltip, /\[\$\(record\) Turn on metering\]\(command:smd\.meter\.turnOn/);
  assert.ok(off.commands.includes('smd.meter.turnOn'));
  assert.equal(off.command, 'smd.showAgentView');
  assert.doesNotMatch(tokenMeter({ raw: 100, agent: 50, brief: 25 }).tooltip, /Turn on metering/);
});

test('with metering on the card shows measured use and opens the meter', () => {
  const ev = (session: string, served: number, op: 'section' | 'raw-read' = 'section', via: 'mcp' | 'hook' = 'mcp') => ({
    v: 1 as const, ts: '2026-11-19T10:00:00.000Z', session, client: { name: 'claude-code', via }, op, file: 'a.smd',
    ...(op === 'section' ? { sections: ['requirements'] } : {}), tokens: { served, file: 6000, tokenizer: 'estimate' }, outcome: 'ok' as const,
  });
  const report = meterReport([ev('s1', 900), ev('s1', 1100), ev('h1', 6000, 'raw-read', 'hook')]);
  const meter = tokenMeter({ raw: 6312, agent: 2104, brief: 1204, metering: true, measured: { period: 'last 7 days', report } });
  assert.equal(meter.text, '$(hubot) 6.3k → 2.1k tok · 2 reads');
  assert.equal(meter.command, 'smd.openTokenMeter');
  assert.match(meter.tooltip, /\*\*Measured\*\* · last 7 days · \*\*67%\*\* saved \(session net\)/);
  assert.match(meter.tooltip, /Bypassed smd &nbsp; claude-code 1 raw read/);
  assert.match(meter.tooltip, /Most read &nbsp; requirements 2/);
  assert.equal(meter.commands[0], 'smd.openTokenMeter');
  const linked = [...meter.tooltip.matchAll(/\]\(command:([\w.]+)/g)].map((m) => m[1]);
  assert.deepEqual(linked, meter.commands, 'every link is trusted and nothing else');

  const worse = meterReport([ev('s1', 5000), ev('s1', 5000)]);
  assert.match(tokenMeter({ raw: 6000, agent: 2000, brief: 1000, metering: true, measured: { period: 'last 7 days', report: worse } }).tooltip, /used 67% more than reading the file once/);
  assert.match(tokenMeter({ raw: 6000, agent: 2000, brief: 1000, metering: true, measured: { period: 'last 7 days', report: meterReport([]) } }).tooltip, /No agent reads of this file yet/);
});
