import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentView, PROVENANCE_SCHEMA, type Provenance } from '../src/core';
import { sha256Hex } from '../src/core/sha256';
import { revisionOf } from '../src/mcpWrite';
import { readDocument } from '../src/readView';

/** C05 (projection provenance) and C04 (opt-in constraints outside the selected sections) of the implementation review. */

const SAMPLES = join(__dirname, 'samples');
const samples = readdirSync(SAMPLES).filter((f) => f.endsWith('.smd'));
const sampleReader = (p: string) => { try { return readFileSync(join(SAMPLES, p), 'utf8'); } catch { return undefined; } };

/** Files by path, for includes and embeds. */
const filesReader = (files: Record<string, string>) => (p: string) => files[p];

const doc = [
  '---', 'title: Payments', 'status: approved', '---', '',
  'Intro text.', '',
  '## Requirements', '',
  '- Refunds within 30 days.', '',
  '<!-- a note for the editor -->', '',
  ':::human For reviewers', 'SECRET_HUMAN_TEXT', ':::', '',
  '## Background {agent=skip}', '', 'Old history.', '',
  '## Operations', '',
  ':::danger No card numbers in logs', 'Mask every PAN before logging.', ':::', '',
  ':::warning Rate limits', 'Stay under 100 requests a second.', ':::', '',
  '> [!CAUTION]', '> Never retry a capture twice.', '',
  '## Decisions', '',
  ':::decision{status=accepted} Use Postgres', 'Chosen for transactions.', ':::', '',
  ':::decision{status=proposed} Use Kafka', 'Not decided.', ':::', '',
  ':::decision{status=superseded} Use MySQL', 'Replaced.', ':::', '',
  '## Open questions', '',
  ':::question Should refunds be partial?', 'Unclear.', ':::', '',
  '## Rules', '',
  ':::agent House rules', 'Write tests.', '::::danger Inside agent', 'ALREADY_SHOWN_DANGER', '::::', ':::', '',
].join('\n');

const lineOf = (text: string, needle: string) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

// ---------------------------------------------------------------------------
// C05: provenance
// ---------------------------------------------------------------------------

test('C05: sha256Hex is SHA-256 of the UTF-8 bytes, and the revision is the MCP one', () => {
  for (const s of ['', 'abc', 'héllo ✓ 𝄞', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), doc]) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
  }
  const p = agentView(doc, { provenance: true }).provenance!;
  assert.equal(p.source.revision, revisionOf(doc));
  assert.equal(p.source.sha256.slice(0, 12), p.source.revision);
});

test('C05: provenance never changes the text, on every sample and setting', () => {
  for (const f of samples) {
    const text = readFileSync(join(SAMPLES, f), 'utf8');
    for (const options of [{}, { brief: true }, { maxTokens: 400 }, { sections: ['Risks'] }, { embed: true }, { includes: false }]) {
      const base = { ...options, readFile: sampleReader, today: '2026-11-06', file: f };
      const plain = agentView(text, base);
      const traced = agentView(text, { ...base, provenance: true });
      assert.equal(traced.text, plain.text, `${f} ${JSON.stringify(options)}`);
      assert.equal(plain.provenance, undefined);
      assert.equal(traced.provenance!.schema, PROVENANCE_SCHEMA);
    }
  }
});

/** Every line of the text that isn't blank is in exactly one span, and spans point inside their files. */
function checkSourceMap(p: Provenance, text: string, files: Record<string, string>): void {
  const out = text.replace(/\n$/, '').split('\n');
  const covered = new Array(out.length + 1).fill(0);
  for (const s of p.sourceMap) {
    assert.ok(s.output[0] >= 1 && s.output[1] <= out.length && s.output[0] <= s.output[1], JSON.stringify(s));
    for (let k = s.output[0]; k <= s.output[1]; k++) covered[k]++;
    if (s.kind === 'source') {
      const lines = (files[s.file!] ?? '').split('\n').length;
      assert.ok(s.source![0] >= 1 && s.source![1] <= lines && s.source![0] <= s.source![1], `${JSON.stringify(s)} in ${lines} lines`);
    }
  }
  out.forEach((line, k) => { if (line.trim()) assert.equal(covered[k + 1], 1, `output line ${k + 1}: ${line}`); });
}

test('C05: the source map covers the view and maps lines back to the document', () => {
  const r = agentView(doc, { provenance: true, file: 'pay.smd' });
  const p = r.provenance!;
  checkSourceMap(p, r.text, { 'pay.smd': doc });
  assert.equal(p.sourceMap[0].kind, 'header');
  assert.deepEqual(p.sourceMap[0].source, [1, 4]);
  // The output line of "Refunds within 30 days." maps to its source line.
  const out = r.text.split('\n').findIndex((l) => l.includes('Refunds within 30 days')) + 1;
  const span = p.sourceMap.find((s) => s.output[0] <= out && out <= s.output[1])!;
  assert.equal(span.kind, 'source');
  assert.ok(span.source![0] <= lineOf(doc, 'Refunds within') && lineOf(doc, 'Refunds within') <= span.source![1]);
  // The human block's lines are never inside a source span.
  const human = lineOf(doc, 'SECRET_HUMAN_TEXT');
  assert.ok(!p.sourceMap.some((s) => s.kind === 'source' && s.source![0] <= human && human <= s.source![1]));
});

test('C05: every omission has a kind, lines and a reason, and hidden text is not exposed', () => {
  const r = agentView(doc, { provenance: true, file: 'pay.smd' });
  const p = r.provenance!;
  const kinds = p.omissions.map((o) => o.kind);
  assert.ok(kinds.includes('human') && kinds.includes('skipped-section') && kinds.includes('comment'), kinds.join());
  for (const o of p.omissions) {
    assert.ok(o.reason.length > 5 && o.lines[0] >= 1 && o.lines[0] <= o.lines[1], JSON.stringify(o));
  }
  const human = p.omissions.find((o) => o.kind === 'human')!;
  assert.deepEqual(human.lines, [lineOf(doc, ':::human'), lineOf(doc, 'SECRET_HUMAN_TEXT') + 1]);
  const skipped = p.omissions.find((o) => o.kind === 'skipped-section')!;
  assert.equal(skipped.heading, 'Background');
  assert.match(skipped.retrieve!, /--section "Background"/);
  assert.deepEqual(p.omissions.find((o) => o.kind === 'comment')!.lines, [lineOf(doc, '<!--'), lineOf(doc, '<!--')]);
  const json = JSON.stringify(p);
  assert.doesNotMatch(json, /SECRET_HUMAN_TEXT|For reviewers|a note for the editor|Old history/);
});

test('C05: brief, budget and selection omissions are listed with reasons', () => {
  const text = readFileSync(join(SAMPLES, 'showcase.smd'), 'utf8');
  const brief = agentView(text, { brief: true, provenance: true, file: 'showcase.smd', readFile: sampleReader }).provenance!;
  for (const kind of ['diagram', 'details', 'completed-tasks', 'embed'] as const) assert.ok(brief.omissions.some((o) => o.kind === kind), kind);
  assert.ok(brief.omissions.find((o) => o.kind === 'completed-tasks')!.count! > 0);
  const budget = agentView(text, { maxTokens: 400, provenance: true, file: 'showcase.smd', readFile: sampleReader });
  const omitted = budget.provenance!.omissions.filter((o) => o.kind === 'budget');
  assert.equal(omitted.length, budget.budget!.omitted.length);
  assert.ok(omitted.every((o) => o.tokens! > 0 && o.retrieve));
  assert.equal(budget.provenance!.budget!.requested, 400);
  assert.equal(budget.provenance!.budget!.condensed, true);
  assert.equal(budget.provenance!.settings.maxTokens, 400);
  checkSourceMap(budget.provenance!, budget.text, { 'showcase.smd': text });
  const selected = agentView(doc, { sections: ['Decisions', 'Nothing here'], provenance: true }).provenance!;
  assert.deepEqual(selected.selection!.missing, ['Nothing here']);
  assert.equal(selected.selection!.resolved[0].headings[0].line, lineOf(doc, '## Decisions'));
  assert.ok(selected.omissions.some((o) => o.kind === 'not-selected' && o.heading === 'Requirements'));
  assert.ok(!selected.omissions.some((o) => o.kind === 'not-selected' && o.heading === 'Decisions'));
});

test('C05: nested includes map to the right file, and their hashes are listed', () => {
  const files: Record<string, string> = {
    'parts/a.smd': '## Part A\n\nFROM_A line.\n\n:::include{file="b.smd"}\n:::\n',
    'parts/b.smd': '## Part B\n\nFROM_B line.\n',
  };
  const root = '# Root\n\nRoot text.\n\n:::include{file="parts/a.smd"}\n:::\n\n:::include{file="missing.smd"}\n:::\n';
  const r = agentView(root, { provenance: true, file: 'root.smd', readFile: filesReader(files) });
  const p = r.provenance!;
  const mapOf = (needle: string) => {
    const k = r.text.split('\n').findIndex((l) => l.includes(needle)) + 1;
    return p.sourceMap.find((s) => s.output[0] <= k && k <= s.output[1])!;
  };
  assert.equal(mapOf('FROM_A').file, 'parts/a.smd');
  assert.ok(mapOf('FROM_A').source![0] <= 3 && mapOf('FROM_A').source![1] >= 3, JSON.stringify(mapOf('FROM_A')));
  assert.equal(mapOf('FROM_B').file, 'parts/b.smd');
  assert.equal(mapOf('<included file="parts/a.smd">').kind, 'synthesized');
  assert.deepEqual(p.source.dependencies.map((d) => [d.path, d.status]), [['missing.smd', 'unavailable'], ['parts/a.smd', 'read'], ['parts/b.smd', 'read']]);
  assert.equal(p.source.dependencies[1].sha256, sha256Hex(files['parts/a.smd']));
  const missing = p.omissions.find((o) => o.kind === 'include')!;
  assert.equal(missing.file, 'root.smd');
  assert.deepEqual(missing.lines, [8, 8]);
  checkSourceMap(p, r.text, { 'root.smd': root, ...files });
});

test('C05: manifests are stable, and a changed file has a new revision', () => {
  const a = agentView(doc, { provenance: true, sections: ['Operations'], constraints: true, today: '2026-11-06' }).provenance;
  const b = agentView(doc, { provenance: true, sections: ['Operations'], constraints: true, today: '2026-11-06' }).provenance;
  assert.deepEqual(a, b);
  assert.equal(a!.settings.datePolicy, 'fixed');
  assert.equal(agentView(doc, { provenance: true }).provenance!.settings.datePolicy, 'clock');
  const changed = agentView(doc.replace('30 days', '14 days'), { provenance: true }).provenance!;
  assert.notEqual(changed.source.revision, a!.source.revision);
});

test('C05: readDocument returns the manifest of what it showed, the outline included', () => {
  const big = readFileSync(join(__dirname, '..', '..', 'docs', 'SPEC-V2-PROPOSALS.smd'), 'utf8');
  const outline = readDocument(big, { provenance: true, file: 'spec.smd' });
  assert.equal(outline.shown, 'outline');
  assert.equal(outline.provenance!.projection, 'outline');
  assert.equal(outline.provenance!.omissions[0].kind, 'outline');
  const full = readDocument(doc, { provenance: true });
  assert.equal(full.shown, 'full');
  assert.equal(full.provenance!.projection, 'agent-view');
  assert.equal(readDocument(doc).provenance, undefined);
});

// ---------------------------------------------------------------------------
// C04: constraints outside the selected sections (opt-in)
// ---------------------------------------------------------------------------

test('C04: the constraints pass is off by default; only the dangers of other sections are shown (decided 2026-11-06)', () => {
  const plain = agentView(doc, { sections: ['Requirements'] });
  assert.doesNotMatch(plain.text, /Constraints elsewhere/);
  assert.equal(plain.constraints, undefined);
  assert.match(plain.text, /Dangers elsewhere in the document:\n<danger title="No card numbers in logs">\nMask every PAN before logging\.\n<\/danger>/);
  assert.doesNotMatch(plain.text, /warning "Rate limits"|accepted decision "Use Postgres"/, 'warnings and decisions stay behind --constraints');
});

test('C04: dangers in full, other constraints as pointers, and nothing that is not a constraint', () => {
  const r = agentView(doc, { sections: ['Requirements'], constraints: true });
  assert.match(r.text, /Constraints elsewhere in the document:\n<danger title="No card numbers in logs">\nMask every PAN before logging\.\n<\/danger>/);
  assert.match(r.text, /<danger>\nNever retry a capture twice\.\n<\/danger>/, 'a CAUTION alert is a danger');
  assert.match(r.text, /- warning "Rate limits" \[L\d+\] in "Operations"/);
  assert.match(r.text, /- accepted decision "Use Postgres" \[L\d+\] in "Decisions"/);
  assert.match(r.text, /- open question "Should refunds be partial\?" \[L\d+\] in "Open questions"/);
  assert.doesNotMatch(r.text, /Stay under 100 requests|Chosen for transactions/, 'pointers, not text');
  assert.doesNotMatch(r.text, /Use Kafka|Use MySQL/, 'proposed and superseded decisions are not constraints');
  assert.equal(r.text.split('ALREADY_SHOWN_DANGER').length - 1, 1, 'a danger inside :::agent is shown once, with the agent block');
  assert.equal(r.constraints!.policy, 'constraints/1');
  assert.equal(r.constraints!.complete, true);
  assert.equal(r.constraints!.shown, 2);
  assert.deepEqual(r.constraints!.pointers.map((p) => p.type), ['danger', 'warning', 'danger', 'decision', 'question']);
  const warning = r.constraints!.pointers.find((p) => p.type === 'warning')!;
  assert.equal(warning.line + 1, lineOf(doc, ':::warning'));
  // The text without line references has no [L…] in the pointers.
  assert.doesNotMatch(agentView(doc, { sections: ['Requirements'], constraints: true, lineRefs: false }).text, /\[L\d+\]/);
});

test('C04: selected sections, skipped sections and :::human blocks are not listed', () => {
  const skipped = doc.replace('Old history.', ':::danger Skipped danger\nHISTORIC_DANGER\n:::');
  const r = agentView(skipped, { sections: ['Operations'], constraints: true });
  assert.doesNotMatch(r.text, /HISTORIC_DANGER/);
  assert.equal(r.text.split('Mask every PAN').length - 1, 1, 'a danger in the selection is shown once, in place');
  assert.ok(!r.constraints!.pointers.some((p) => p.section === 'Operations'));
  const whole = agentView(doc, { constraints: true });
  assert.equal(whole.constraints, undefined, 'a whole view already has every constraint');
  assert.equal(whole.text, agentView(doc).text);
});

test('C04: an include outside the selection is listed and makes the view incomplete', () => {
  const withInclude = `${doc}\n## Appendix\n\n:::include{file="policy.smd"}\n:::\n`;
  const r = agentView(withInclude, { sections: ['Requirements'], constraints: true, readFile: () => '## Policy\n\n:::danger Inner\nINNER\n:::\n' });
  assert.equal(r.constraints!.complete, false);
  assert.match(r.text, /- included file policy\.smd \[L\d+\] in "Appendix": not checked for constraints/);
  assert.doesNotMatch(r.text, /INNER/);
});

test('C04: works with a budget and through readDocument, and the manifest records the policy', () => {
  const budget = agentView(doc, { sections: ['Requirements'], constraints: true, maxTokens: 50 });
  assert.match(budget.text, /Mask every PAN/, 'the constraints are part of the head, which is never omitted');
  const read = readDocument(doc, { sections: ['Requirements'], constraints: true, provenance: true });
  assert.equal(read.constraints!.policy, 'constraints/1');
  assert.equal(read.provenance!.constraints!.policy, 'constraints/1');
  assert.equal(read.provenance!.settings.constraints, true);
  // The danger's lines in the constraints part map to its source lines.
  const out = read.text.split('\n').findIndex((l) => l === 'Mask every PAN before logging.') + 1;
  const span = read.provenance!.sourceMap.find((s) => s.output[0] <= out && out <= s.output[1])!;
  assert.equal(span.kind, 'source');
  assert.ok(span.source![0] <= lineOf(doc, 'Mask every PAN') && lineOf(doc, 'Mask every PAN') <= span.source![1]);
});
