import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  declaredSectionEdges, filterEvents, meterReport, parseMeterLines, sectionGraph, sectionGraphMermaid, shortTokens, type MeterEvent,
} from '../src/core';
import {
  appendEvents, clearEvents, eventFiles, meterSettings, pruneEvents, readEvents, resetMeterLogState, setMeterConfig,
} from '../src/meter/log';
import {
  beginMeterCall, buildEvents, claudeSession, cliClient, cliSession, endMeterCall, noteAccess, trackReads,
} from '../src/meter/record';
import { mergeClaudeHook, meterHook, meterReportText, HOOK_COMMAND } from '../src/meterCommand';
import { McpServer, type JsonRpcResponse } from '../src/mcpProtocol';
import { mcpMeter, Sandbox, smdTools } from '../src/mcp';
import { graphSvg, meterPanelBody, type MeterPanelModel } from '../src/meterPanelHtml';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-meter-'));
  dirs.push(dir);
  return dir;
};
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => resetMeterLogState());

/** An event with defaults: a section read of docs/a.smd (6,000 tokens) in session s1. */
function ev(over: Partial<MeterEvent> & { served?: number; file?: string } = {}): MeterEvent {
  const { served = 1000, ...rest } = over;
  return {
    v: 1, ts: '2026-11-19T10:00:00.000Z', session: 's1', client: { name: 'claude-code', via: 'mcp' }, op: 'section',
    file: 'docs/a.smd', sections: ['requirements'], tokens: { served, file: 6000, tokenizer: 'estimate' }, outcome: 'ok', ...rest,
  };
}

// KPIs

test('AC4: session net savings count the file once per session', () => {
  const report = meterReport([
    ev({ sections: ['a'], served: 900 }),
    ev({ ts: '2026-11-19T10:01:00.000Z', sections: ['b'], served: 1100 }),
  ]);
  assert.deepEqual(report.kpis.sessionNet, { baseline: 6000, served: 2000, saved: 4000, percent: 67 });
  assert.deepEqual(report.kpis.perRead, { baseline: 12000, served: 2000, saved: 10000, percent: 83 }, 'per-read counts the file twice');
});

test('AC5: negative session net savings are reported as they are', () => {
  const reads = Array.from({ length: 5 }, (_, i) => ev({ ts: `2026-11-19T10:0${i}:00.000Z`, served: 1500 }));
  const net = meterReport(reads).kpis.sessionNet;
  assert.equal(net.served, 7500);
  assert.equal(net.saved, -1500);
  assert.equal(net.percent, -25);
  assert.match(meterReportText(meterReport(reads)), /-1,500 tokens \(-25%\)[\s\S]*more through smd than reading each file once/);
});

test('sessions, includes, failures and raw reads in the KPIs', () => {
  const events = [
    ev({ session: 's1', served: 500, tokens: { served: 500, file: 4000, includes: 1000, tokenizer: 'estimate' } }),
    ev({ session: 's2', served: 700 }),
    ev({ session: 's2', outcome: 'not-found', served: 0 }),
    ev({ session: 'h1', op: 'raw-read', client: { name: 'claude-code', via: 'hook' }, sections: undefined, served: 6000 }),
    ev({ session: 'c1', client: { name: 'codex', via: 'cli' }, op: 'query', served: 300 }),
    ev({ session: 'c1', client: { name: 'codex', via: 'cli' }, op: 'tasks', file: undefined, files: ['docs/a.smd'], sections: undefined, tokens: { served: 200, tokenizer: 'estimate' } }),
  ];
  const r = meterReport(events);
  // s1: 5,000 baseline (file plus includes) vs 500; s2: 6,000 vs 700 (the failed read serves 0); c1: 6,000 vs 300.
  assert.deepEqual(r.kpis.sessionNet, { baseline: 17000, served: 1500, saved: 15500, percent: 91 });
  assert.equal(r.kpis.reads, 5, 'raw reads are not smd reads');
  assert.equal(r.kpis.served, 1700);
  const claude = r.clients.find((c) => c.name === 'claude-code')!;
  assert.equal(claude.rawReads, 1);
  assert.equal(claude.share, 75, '3 smd reads, 1 raw read');
  assert.equal(r.clients.find((c) => c.name === 'codex')!.share, null, 'no hook: not measured');
  assert.equal(r.kpis.smdShare, 75);
  assert.equal(r.kpis.targeted.percent, 80, 'four section/query reads of five');
  assert.equal(r.files[0].rawReads, 1);
});

test('re-reads, sections and mixed tokenizers', () => {
  const r = meterReport([
    ev({ sections: ['a', 'b'], served: 1000 }),
    ev({ ts: '2026-11-19T10:05:00.000Z', sections: ['a'], served: 400 }),
    ev({ session: 's2', sections: ['a'], tokens: { served: 300, file: 5800, tokenizer: 'o200k_base' } }),
  ]);
  assert.deepEqual(r.sections.map((s) => [s.slug, s.reads, s.sessions, s.rereads, s.served]), [['a', 3, 2, 1, 1200], ['b', 1, 1, 0, 500]]);
  assert.equal(r.kpis.rereads.count, 1);
  assert.deepEqual(r.tokenizers, ['estimate', 'o200k_base']);
  assert.deepEqual(r.kpis.byTokenizer, {
    estimate: { baseline: 6000, served: 1400, saved: 4600, percent: 77 },
    o200k_base: { baseline: 5800, served: 300, saved: 5500, percent: 95 },
  });
});

test('filters by period and path', () => {
  const events = [ev({ ts: '2026-11-01T00:00:00.000Z' }), ev({ ts: '2026-11-19T00:00:00.000Z', file: 'other/b.smd' })];
  assert.equal(filterEvents(events, { since: '2026-11-10' }).length, 1);
  assert.equal(filterEvents(events, { until: '2026-11-10' }).length, 1);
  assert.equal(filterEvents(events, { paths: ['docs'] }).length, 1);
  assert.equal(filterEvents(events, { paths: ['docs/a.smd'] }).length, 1);
  assert.equal(filterEvents(events, { paths: ['.'] }).length, 2);
  assert.equal(meterReport([], {}).events, 0);
});

test('parses JSON Lines, skipping torn and foreign lines', () => {
  const good = JSON.stringify(ev());
  const text = `${good}\n{"v":1,"ts":\n\n${JSON.stringify({ ...ev(), v: 2 })}\nnot json\n${good}\n`;
  assert.equal(parseMeterLines(text).length, 2);
  assert.equal(shortTokens(6312), '6.3k');
  assert.equal(shortTokens(-1500), '−1.5k');
  assert.equal(shortTokens(2_400_000), '2.4M');
});

// Section graph

test('co-read, followed and declared edges and the two findings', () => {
  const at = (min: number) => `2026-11-19T10:${String(min).padStart(2, '0')}:00.000Z`;
  const events: MeterEvent[] = [];
  for (const s of ['s1', 's2', 's3']) {
    events.push(ev({ session: s, ts: at(0), sections: ['requirements'] }), ev({ session: s, ts: at(2), sections: ['api'] }));
  }
  events.push(ev({ session: 's4', ts: at(0), sections: ['requirements'] }), ev({ session: 's4', ts: at(30), sections: ['risks'] }));
  events.push(ev({ session: 's5', follow: [{ from: 'requirements', to: 'constraints' }] }));
  const g = sectionGraph(events, { declared: [{ from: 'docs/a.smd#risks', to: 'docs/a.smd#rollout', type: 'depends-on' }] });
  const edge = (kind: string) => g.edges.filter((x) => x.kind === kind).map((x) => `${x.a.split('#')[1]}-${x.b.split('#')[1]}:${x.weight}`);
  assert.deepEqual(edge('co-read'), ['api-requirements:3'], 'the 30-minute gap in s4 is outside the window');
  assert.deepEqual(edge('followed'), ['requirements-constraints:1']);
  assert.deepEqual(edge('declared'), ['risks-rollout:0']);
  assert.deepEqual(g.findings.declaredNeverFollowed.map((x) => x.type), ['depends-on']);
  assert.deepEqual(g.findings.readTogetherNotLinked.map((x) => x.weight), [3]);
  assert.equal(g.nodes[0].slug, 'requirements');
  const mermaid = sectionGraphMermaid(g);
  assert.match(mermaid, /^flowchart LR\n  accTitle:/);
  assert.match(mermaid, /---\|3\|/);
  assert.match(mermaid, /-->\|followed 1\|/);
  assert.match(mermaid, /-\.-\|depends-on\|/);
  assert.match(graphSvg(g), /<svg[^>]+role="img"/);
});

test('declared section edges come from the document graph', () => {
  const text = [
    '---', 'smd: 2', 'title: T', '---', '', '## Requirements', '', ':::requirement{#R1} One', 'Text', ':::', '',
    '## Constraints', '', ':::constraint{#C1 applies-to=R1} Keep it', ':::', '', '## Notes', '', 'See :ref[R1].', '',
  ].join('\n');
  const edges = declaredSectionEdges('docs/t.smd', text);
  const pairs = edges.map((x) => `${x.from.split('#')[1]}>${x.to.split('#')[1]}:${x.type}`).sort();
  assert.ok(pairs.includes('constraints>requirements:applies-to'), pairs.join(', '));
  assert.ok(pairs.includes('notes>requirements:ref'), pairs.join(', '));
});

// Log

test('off by default; on from .smdrc; SMD_METER=off wins', () => {
  const root = tempDir();
  assert.equal(meterSettings(root, { env: {} }).enabled, false);
  assert.equal(meterSettings(root, { env: {} }).off, 'config');
  setMeterConfig(root, true);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.smdrc'), 'utf8')), { meter: true });
  assert.equal(meterSettings(root, { env: {} }).enabled, true);
  assert.equal(meterSettings(root, { env: { SMD_METER: 'off' } }).enabled, false);
  writeFileSync(join(root, '.smdrc'), JSON.stringify({ rules: { 'link/bare': 'off' }, meter: { retentionDays: 30, maxMegabytes: 1, tokenizer: 'o200k_base' } }));
  const s = meterSettings(root, { env: {} });
  assert.deepEqual([s.enabled, s.retentionDays, s.maxBytes, s.tokenizer], [true, 30, 1048576, 'o200k_base']);
  setMeterConfig(root, false);
  const config = JSON.parse(readFileSync(join(root, '.smdrc'), 'utf8'));
  assert.deepEqual(config.rules, { 'link/bare': 'off' }, 'other keys kept');
  assert.equal(config.meter.enabled, false);
  assert.equal(meterSettings(root, { force: true, env: {} }).enabled, true, 'force (the editor) turns it on');
});

test('appends whole lines, ignores itself in Git, prunes old months and clears', () => {
  const root = tempDir();
  setMeterConfig(root, true);
  const settings = meterSettings(root, { env: {} });
  assert.equal(appendEvents(settings, [ev(), ev({ session: 's2' })]), true);
  assert.equal(readFileSync(join(root, '.smd', '.gitignore'), 'utf8').split('\n')[1], '*');
  assert.equal(readEvents(settings.dir).length, 2);
  writeFileSync(join(settings.dir, 'events-2025-01.jsonl'), `${JSON.stringify(ev())}\n`);
  assert.deepEqual(pruneEvents(settings.dir, 90, new Date('2026-11-19')).map((f) => f.slice(-20)), ['events-2025-01.jsonl']);
  assert.equal(eventFiles(settings.dir).length, 1);
  assert.equal(clearEvents(settings.dir), 1);
  assert.equal(readEvents(settings.dir).length, 0);
  assert.equal(appendEvents({ ...settings, enabled: false }, [ev()]), false, 'off writes nothing');
});

test('R2: a log that cannot be written fails quietly, once', () => {
  const root = tempDir();
  writeFileSync(join(root, 'blocker'), 'a file where the folder should be');
  const settings = { ...meterSettings(root, { force: true, env: {} }), dir: join(root, 'blocker', 'meter') };
  const warnings: string[] = [];
  assert.equal(appendEvents(settings, [ev()], (m) => warnings.push(m)), false);
  assert.equal(appendEvents(settings, [ev()], (m) => warnings.push(m)), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Reads are not affected/);
});

test('stops at the size cap', () => {
  const root = tempDir();
  const settings = { ...meterSettings(root, { force: true, env: {} }), maxBytes: 10 };
  mkdirSync(settings.dir, { recursive: true });
  writeFileSync(join(settings.dir, 'events-2026-11.jsonl'), 'x'.repeat(20));
  const warnings: string[] = [];
  assert.equal(appendEvents(settings, [ev()], (m) => warnings.push(m)), false);
  assert.match(warnings[0], /paused/);
});

// Recording

test('notes become one event per document, with includes in the baseline', () => {
  const root = tempDir();
  mkdirSync(join(root, 'docs'));
  const doc = join(root, 'docs', 'a.smd');
  writeFileSync(doc, '---\nsmd: 2\ntitle: A\n---\n\n## Requirements\n\nText.\n\n## Risks\n\nMore.\n');
  writeFileSync(join(root, 'docs', 'part.smd'), 'x'.repeat(400));
  const settings = meterSettings(root, { force: true, env: {} });
  beginMeterCall();
  const reader = trackReads(doc, (rel: string) => readFileSync(join(root, 'docs', rel), 'utf8'));
  reader('part.smd');
  noteAccess({ file: doc, op: 'section', sections: ['requirements'] });
  noteAccess({ file: doc, op: 'section', sectionTitles: ['Risks', 'No such heading'], follow: [{ from: 'Risks', to: 'Requirements' }] });
  const call = endMeterCall()!;
  noteAccess({ file: doc, op: 'agent' });
  assert.equal(call.notes.length, 2, 'notes outside a call are dropped');
  const [event] = buildEvents(call, { settings, client: { name: 'claude-code', via: 'cli' }, session: 'cli-1', served: 'y'.repeat(800), now: new Date('2026-11-19T10:00:00Z') });
  assert.equal(event.file, 'docs/a.smd');
  assert.deepEqual(event.sections, ['requirements', 'risks']);
  assert.deepEqual(event.follow, [{ from: 'risks', to: 'requirements' }]);
  assert.deepEqual(event.tokens, { served: 200, file: Math.ceil(readFileSync(doc, 'utf8').length / 4), includes: 100, tokenizer: 'estimate' });
  assert.match(event.fileHash!, /^[0-9a-f]{8}$/);
  assert.equal(JSON.stringify(event).includes('Text.'), false, 'C1: no document text');
});

test('a call over several documents splits what was served', () => {
  const root = tempDir();
  writeFileSync(join(root, 'a.smd'), '# A\n');
  writeFileSync(join(root, 'b.smd'), '# B\n');
  const settings = meterSettings(root, { force: true, env: {} });
  beginMeterCall();
  noteAccess({ file: join(root, 'a.smd'), op: 'query', served: 'a'.repeat(40), query: 'decision' });
  noteAccess({ file: join(root, 'b.smd'), op: 'query', served: 'b'.repeat(80), query: 'decision' });
  noteAccess({ file: join(root, 'a.smd'), op: 'tasks' });
  const events = buildEvents(endMeterCall()!, { settings, client: { name: 'x', via: 'cli' }, session: 's', served: 'z'.repeat(400) });
  assert.deepEqual(events.map((e) => [e.op, e.file ?? e.files?.join(','), e.tokens.served]), [['tasks', 'a.smd', 100], ['query', 'a.smd', 10], ['query', 'b.smd', 20]]);
  assert.equal(events[1].query, 'decision');
  beginMeterCall();
  noteAccess({ file: join(tmpdir(), 'outside.smd'), op: 'agent' });
  assert.deepEqual(buildEvents(endMeterCall()!, { settings, client: { name: 'x', via: 'cli' }, session: 's', served: 'z' }), [], 'files outside the workspace are not logged');
});

test('clients and sessions from the environment', () => {
  assert.equal(cliClient({ CLAUDECODE: '1' }).name, 'claude-code');
  assert.equal(cliClient({ CODEX_SANDBOX: 'seatbelt' }).name, 'codex');
  assert.equal(cliClient({ SMD_CLIENT: 'my-agent', CLAUDECODE: '1' }).name, 'my-agent');
  assert.equal(cliClient({}).name, 'unknown');
  const root = tempDir();
  const settings = meterSettings(root, { force: true, env: {} });
  assert.equal(cliSession(settings, 'claude-code', { CLAUDE_CODE_SESSION_ID: 'abc-123' }), 'claude-abc-123');
  assert.equal(cliSession(settings, 'x', { SMD_SESSION: 'run/7' }), 'cli-run7');
  const first = cliSession(settings, 'codex', {}, 1_000_000);
  assert.equal(cliSession(settings, 'codex', {}, 1_000_000 + 60_000), first, 'within the idle gap');
  assert.notEqual(cliSession(settings, 'codex', {}, 1_000_000 + 60_000 + 31 * 60_000), first, 'after the idle gap');
  assert.equal(claudeSession('abc-123'), 'claude-abc-123');
});

// Hook

test('the hook records raw reads of .smd files inside the workspace only', () => {
  const root = tempDir();
  writeFileSync(join(root, 'plan.smd'), '## Plan\n\n' + 'w'.repeat(396));
  setMeterConfig(root, true);
  const settings = meterSettings(root, { env: {} });
  const input = (file: string) => JSON.stringify({ session_id: 'abc-123', cwd: root, tool_name: 'Read', tool_input: { file_path: file } });
  const event = meterHook(input('plan.smd'), settings, new Date('2026-11-19T10:00:00Z'))!;
  assert.deepEqual([event.op, event.file, event.session, event.client.via, event.tokens.served, event.tokens.file], ['raw-read', 'plan.smd', 'claude-abc-123', 'hook', 102, 102]);
  assert.equal(meterHook(input('notes.md'), settings), undefined);
  assert.equal(meterHook(input(join(tmpdir(), 'elsewhere.smd')), settings), undefined);
  assert.equal(meterHook('', settings), undefined);
  assert.equal(readEvents(settings.dir).length, 1);
});

test('the Claude Code hook is merged into settings once, other settings kept', () => {
  const merged = JSON.parse(mergeClaudeHook(JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [] }] } }))!);
  assert.deepEqual(merged.permissions, { allow: ['Bash(ls)'] });
  assert.equal(merged.hooks.PostToolUse.length, 2);
  assert.equal(merged.hooks.PostToolUse[1].matcher, 'Read');
  assert.equal(merged.hooks.PostToolUse[1].hooks[0].command, HOOK_COMMAND);
  assert.equal(mergeClaudeHook(JSON.stringify(merged)), undefined, 'already there');
  assert.ok(mergeClaudeHook(undefined));
  assert.throws(() => mergeClaudeHook('// comment\n{}'));
});

// MCP

test('R1, R2, R3: MCP reads are recorded with the client from initialize, results unchanged', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'spec.smd'), '---\nsmd: 2\ntitle: Spec\n---\n\n## Requirements\n\nShip it.\n\n## Risks\n\nNone.\n');
  const box = new Sandbox(root);
  const make = (meter: boolean) => new McpServer({ name: 's', version: '1', tools: smdTools(box), ...(meter ? { meter: mcpMeter(box) } : {}) });
  const ask = async (server: McpServer, method: string, params: unknown) => ((await server.handle({ jsonrpc: '2.0', id: 1, method, params })) as JsonRpcResponse).result;
  const read = { name: 'read', arguments: { file: 'spec.smd', sections: ['Requirements'] } };

  const plain = make(false);
  const expected = await ask(plain, 'tools/call', read);
  const metered = make(true);
  await ask(metered, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1.0' } });
  assert.deepEqual(await ask(metered, 'tools/call', read), expected, 'metering off: nothing recorded, same result');
  assert.equal(existsSync(join(root, '.smd')), false);

  setMeterConfig(root, true);
  assert.deepEqual(await ask(metered, 'tools/call', read), expected, 'metering on: same result');
  await ask(metered, 'tools/call', { name: 'read', arguments: { file: 'spec.smd', sections: ['Nothing'] } });
  await ask(metered, 'tools/call', { name: 'validate', arguments: {} });
  const events = readEvents(meterSettings(root, { env: {} }).dir);
  assert.deepEqual(events.map((e) => [e.op, e.sections?.join(','), e.outcome, e.client.name, e.client.version, e.client.via]), [
    ['section', 'requirements', 'ok', 'claude-code', '2.1.0', 'mcp'],
    ['section', undefined, 'not-found', 'claude-code', '2.1.0', 'mcp'],
  ]);
  assert.equal(events[0].session, events[1].session, 'one connection, one session');
  assert.match(events[0].session, /^mcp-/);
  const text = (expected as { content: Array<{ text: string }> }).content[0].text;
  assert.equal(events[0].tokens.served, Math.ceil(text.length / 4), 'served counts the whole result');
});

// Panel

test('the panel shows the off state, the KPIs and never-read sections', () => {
  const base: MeterPanelModel = { root: '/w', enabled: false, off: 'config', period: '30', tab: 'overview', report: meterReport([]), files: [] };
  assert.match(meterPanelBody(base), /data-msg="turnOn"/);
  assert.doesNotMatch(meterPanelBody({ ...base, off: 'env' }), /data-msg="turnOn"/);
  assert.match(meterPanelBody({ ...base, enabled: true, off: undefined }), /No agent reads yet/);

  const events = [ev({ sections: ['requirements'], served: 900 }), ev({ session: 's2', sections: ['requirements'], served: 7000 })];
  const report = meterReport(events);
  const html = meterPanelBody({
    ...base, enabled: true, off: undefined, tab: 'sections', report, files: ['docs/a.smd'], file: 'docs/a.smd', fileReport: report,
    graph: sectionGraph(events), headings: [{ slug: 'requirements', text: 'Requirements', level: 2, skip: false }, { slug: 'rollout', text: 'Roll<out>', level: 2, skip: false }],
  });
  assert.match(html, /Session net savings/);
  // 12,000 baseline (two sessions) against 7,900 served: positive overall although session 2 alone served more.
  assert.doesNotMatch(html, /class="kpi warn"/);
  assert.match(html, /4\.1k <small>\(34%\)<\/small>/);
  assert.match(html, /never read/);
  assert.match(html, /Roll&lt;out&gt;/, 'escaped');
  assert.match(html, /data-pane="sections"(?! hidden)/);
});
