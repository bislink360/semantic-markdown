import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meterReport } from '../src/core';
import { BAR_COLORS, BAR_HEIGHT, BAR_WIDTH, bar, barFill, savedPercent, savingsBar, shortCount, tokenMeter } from '../src/tokenMeter';

/** The bars in a card or a line: alt text, and the SVG decoded. */
const bars = (markdown: string) => [...markdown.matchAll(/!\[([^\]]*)\]\(data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)\)/g)]
  .map((m) => ({ alt: m[1], svg: atob(m[2]) }));
/** The filled rectangle of a bar's SVG: its width and colour, or undefined for an empty bar. */
const fillOf = (svg: string) => {
  const m = [...svg.matchAll(/<rect width="(\d+)"[^>]*fill="(#[0-9a-f]+)"\/>/g)];
  return m.length ? { width: Number(m[0][1]), color: m[0][2] } : undefined;
};

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

test('bars are thin SVG images, which the hover renderer allows as data: URIs', () => {
  const [b] = bars(bar(60, 240, 'brief', '60 tokens'));
  assert.equal(b.alt, '60 tokens');
  assert.match(b.svg, new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="${BAR_HEIGHT}"`));
  assert.match(b.svg, /fill="#808080" fill-opacity="0.25"/, 'a faint track under the fill');
  assert.deepEqual(fillOf(b.svg), { width: 60, color: BAR_COLORS.brief });
  assert.equal(barFill(1, 10_000), BAR_HEIGHT, 'a tiny value still shows');
  assert.equal(barFill(500, 100), BAR_WIDTH, 'never past the end');
  assert.equal(barFill(0, 0), 0);
  assert.equal(fillOf(bars(bar(0, 100, 'raw', 'none'))[0].svg), undefined, 'an empty bar is the track alone');
  assert.equal(bars(bar(1, 2, 'raw', 'a [b] c'))[0].alt, 'a b c', 'brackets would end the alt text');
});

test('the savings bar fills to the percentage, and warns when smd sent more', () => {
  assert.deepEqual(fillOf(bars(savingsBar(67))[0].svg), { width: Math.round(0.67 * BAR_WIDTH), color: BAR_COLORS.saved });
  assert.equal(bars(savingsBar(67))[0].alt, '67% saved');
  assert.deepEqual(fillOf(bars(savingsBar(-20))[0].svg), { width: BAR_WIDTH, color: BAR_COLORS.warn });
  assert.equal(bars(savingsBar(-20))[0].alt, '20% more');
});

test('the meter compares the raw file with the agent and brief views', () => {
  const meter = tokenMeter({ raw: 6312, agent: 2104, brief: 1204 });
  assert.equal(meter.text, '$(hubot) 6.3k → 2.1k tok');
  assert.match(meter.tooltip, /### 67% fewer tokens with smd/);
  assert.match(meter.tooltip, /Without smd · raw file &nbsp; \*\*≈6,312\*\* tok/);
  assert.match(meter.tooltip, /With smd · agent view &nbsp; \*\*≈2,104\*\* tok · \*\*67%\*\* fewer/);
  assert.match(meter.tooltip, /With smd · brief view &nbsp; \*\*≈1,204\*\* tok · \*\*81%\*\* fewer/);
  // First the share saved, then the raw file filling its bar and the views drawn to the same scale.
  assert.deepEqual(bars(meter.tooltip).map((b) => fillOf(b.svg)), [
    { width: Math.round(0.67 * BAR_WIDTH), color: BAR_COLORS.saved },
    { width: BAR_WIDTH, color: BAR_COLORS.raw },
    { width: Math.round((2104 / 6312) * BAR_WIDTH), color: BAR_COLORS.agent },
    { width: Math.round((1204 / 6312) * BAR_WIDTH), color: BAR_COLORS.brief },
  ]);
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
  assert.equal(bars(meter.tooltip)[0].alt, '50% more', 'the headline bar warns');
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
  assert.equal(bars(meter.tooltip)[0].alt, '67% saved', 'the measured saving leads with its own bar');
  assert.match(meter.tooltip, /Bypassed smd &nbsp; claude-code 1 raw read/);
  assert.match(meter.tooltip, /Most read &nbsp; requirements 2/);
  assert.equal(meter.commands[0], 'smd.openTokenMeter');
  const linked = [...meter.tooltip.matchAll(/\]\(command:([\w.]+)/g)].map((m) => m[1]);
  assert.deepEqual(linked, meter.commands, 'every link is trusted and nothing else');

  const worse = meterReport([ev('s1', 5000), ev('s1', 5000)]);
  const worseCard = tokenMeter({ raw: 6000, agent: 2000, brief: 1000, metering: true, measured: { period: 'last 7 days', report: worse } }).tooltip;
  assert.match(worseCard, /used 67% more than reading the file once/);
  assert.equal(bars(worseCard)[0].alt, '67% more');
  assert.match(tokenMeter({ raw: 6000, agent: 2000, brief: 1000, metering: true, measured: { period: 'last 7 days', report: meterReport([]) } }).tooltip, /No agent reads of this file yet/);
});
