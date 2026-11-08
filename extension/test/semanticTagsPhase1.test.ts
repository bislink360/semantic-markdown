import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentView, applyFixes, fillTemplate, formatSmd, indexEntry, outline, querySmd, renderSmd, smdToMarkdown, validateSmd,
} from '../src/core';
import { exportTree } from '../src/core/exportTree';
import { documentSymbols } from '../src/core/symbols';
import { nextIds } from '../src/core/semanticCheck';
import { completionsAt, hoverAt } from '../src/lspAssist';

/**
 * Semantic tags phase 1 (docs/rfcs/semantic-tags.smd): requirement, constraint and acceptance on every surface, their
 * validator codes and the templates. Test names give the requirement and acceptance ids they cover.
 */

const TODAY = '2026-11-07';
const v2 = (body: string) => `---\nsmd: 2\ntitle: T\n---\n\n${body}\n`;
const found = (text: string, code: string, options = {}) => validateSmd(text, { today: TODAY, ...options }).filter((d) => d.code === code);

const SAMPLE = v2([
  ':::constraint{#C1 scope=document} Included files stay inside the workspace',
  'No reader follows a path outside the allowed roots.',
  ':::',
  '',
  '## Requirements',
  '',
  ':::requirement{#R1 priority=P0 status=accepted owner=@api-team} Section reads keep applicable instructions',
  'Selecting a nested section returns every agent block.',
  '',
  ':::acceptance{#AC1 test="test/agentView.test.ts"}',
  'Given a document with an agent block',
  'Then the view holds it',
  ':::',
  ':::',
  '',
  ':::requirement{#R2} Views stay small',
  ':::',
  '',
  ':::constraint{#C2 applies-to=R1 level=should} Keep views under 2,000 tokens',
  ':::',
  '',
  ':::acceptance{#AC2 verifies=R2,R1}',
  'Given a view',
  ':::',
].join('\n'));

test('AC20 (R4): each tag is a tag in the agent view, with the defaults that change meaning', () => {
  const view = agentView(SAMPLE).text;
  assert.match(view, /^<constraint id="C1" scope="document" level="must"> Included files stay inside the workspace$/m);
  assert.match(view, /^<requirement id="R1" priority="P0" status="accepted" owner="@api-team"> Section reads keep applicable instructions$/m);
  assert.match(view, /^<requirement id="R2" status="proposed"> Views stay small$/m, 'a requirement without a status is shown as proposed');
  assert.match(view, /^<constraint id="C2" applies-to="R1" level="should"> Keep views under 2,000 tokens$/m);
  assert.match(view, /^<\/requirement>$/m);
  assert.match(view, /^<\/constraint>$/m);
});

test('AC9 (R33): a nested acceptance block verifies its requirement, first in verifies, on every surface', () => {
  assert.match(agentView(SAMPLE).text, /^<acceptance id="AC1" verifies="R1" test="test\/agentView\.test\.ts">$/m);
  assert.match(agentView(SAMPLE).text, /^<acceptance id="AC2" verifies="R2,R1">$/m);
  assert.deepEqual(querySmd(SAMPLE, 'acceptance[verifies=R1]').map((m) => m.attrs.id), ['AC1', 'AC2']);
  assert.equal(querySmd(SAMPLE, 'acceptance[id=AC1]')[0].attrs.verifies, 'R1');
  assert.match(renderSmd(SAMPLE).html, /<span class="smd-block-kind">Acceptance<\/span><span class="smd-block-id">AC1<\/span><span class="smd-block-facts">verifies <a class="smd-ref" href="#R1"/);
  assert.match(smdToMarkdown(SAMPLE), /^> > \*\*Acceptance AC1\*\* · verifies R1 · test test\/agentView\.test\.ts$/m);
});

test('AC20 (R5): plain Markdown writes GitHub alerts with a facts line and never the tag syntax', () => {
  const md = smdToMarkdown(SAMPLE);
  assert.match(md, /^> \[!CAUTION\]\n> \*\*Constraint C1\*\* · must · whole document\n>\n> Included files stay inside the workspace$/m);
  assert.match(md, /^> \[!IMPORTANT\]\n> \*\*Requirement R1\*\* · P0 · accepted · @api-team\n>\n> Section reads keep applicable instructions$/m);
  assert.match(md, /^> \[!IMPORTANT\]\n> \*\*Requirement R2\*\* · proposed$/m);
  assert.match(md, /^> \[!WARNING\]\n> \*\*Constraint C2\*\* · should · applies to R1$/m, 'R30: should is a WARNING');
  assert.match(md, /^> \[!NOTE\]\n> \*\*Acceptance AC2\*\* · verifies R2, R1$/m);
  assert.doesNotMatch(md, /:::|smd-/);
});

test('R3: HTML is a smd-<tag> block with its id, kind, pills with text labels and facts', () => {
  const html = renderSmd(SAMPLE).html;
  assert.match(html, /<div id="R1" class="smd-block smd-requirement smd-requirement-accepted" data-line="\d+"><div class="smd-block-head"><span class="smd-block-kind">Requirement<\/span><span class="smd-block-id">R1<\/span><span class="smd-priority" style="--smd-badge:var\(--smd-red\)">P0<\/span><span class="smd-pill smd-pill-status smd-pill-status-accepted">accepted<\/span><span class="smd-block-facts">@api-team<\/span><\/div><div class="smd-block-title">Section reads keep applicable instructions<\/div><div class="smd-block-body">/);
  assert.match(html, /<span class="smd-pill smd-pill-level smd-pill-level-must">must<\/span><span class="smd-block-facts">applies to the whole document<\/span>/);
  assert.match(html, /applies to <a class="smd-ref" href="#R1" title="Section reads keep applicable instructions" aria-label="R1, Section reads keep applicable instructions">R1<\/a>/);
  assert.match(html, /test <a href="test\/agentView\.test\.ts"><code>test\/agentView\.test\.ts<\/code><\/a>/);
});

test('R3: the stylesheet colours each tag and pill in both themes from the palette', () => {
  const css = readFileSync(join(__dirname, '..', 'media', 'smd.css'), 'utf8');
  for (const rule of ['.smd-block {', '.smd-constraint {', '.smd-acceptance {', '.smd-assumption {', '.smd-evidence {', '.smd-pill {', '.smd-block-head {']) {
    assert.ok(css.includes(rule), rule);
  }
  // Colours come from the theme's variables, which the dark theme redefines.
  assert.match(css, /\.smd-pill \{[^}]*color-mix\(in srgb, var\(--p\) var\(--smd-ink\), var\(--smd-fg\)\)/);
});

test('R10: the labels the renderer adds are translated in every label language', () => {
  const de = renderSmd(SAMPLE.replace('title: T', 'title: T\nlang: de')).html;
  assert.match(de, /<span class="smd-block-kind">Anforderung<\/span>/);
  assert.match(de, /<span class="smd-pill smd-pill-status smd-pill-status-accepted">angenommen<\/span>/);
  assert.match(de, /gilt für das ganze Dokument/);
  for (const lang of ['es', 'fr', 'ja', 'pt', 'zh']) {
    const html = renderSmd(SAMPLE.replace('title: T', `title: T\nlang: ${lang}`)).html;
    assert.doesNotMatch(html, /<span class="smd-block-kind">Requirement<\/span>/, lang);
  }
});

test('R5: exports show each tag as a panel with its facts', () => {
  const tree = exportTree(SAMPLE);
  const panels = JSON.stringify(tree.blocks);
  assert.match(panels, /"kind":"panel","type":"constraint","title":"Constraint C1: Included files stay inside the workspace"/);
  assert.match(panels, /"kind":"panel","type":"requirement","title":"Requirement R1: Section reads keep applicable instructions"/);
  assert.match(panels, /"kind":"panel","type":"acceptance","title":"Acceptance AC1","blocks":\[\{"kind":"paragraph","content":\[\{"kind":"text","text":"verifies R1"/);
});

test('AC4 (R21): a requirement without an id warns, and the fix adds the next free id in the document\'s pattern', () => {
  const text = v2([1, 2, 3].map((n) => `:::requirement{#R${n}} Req ${n}\n:::\n`).join('\n') + '\n:::requirement{priority=P1} Missing\n:::\n\n:::requirement Bare\n:::');
  const diags = found(text, 'requirement/id');
  assert.equal(diags.length, 2);
  assert.equal(diags[0].severity, 'warning');
  const fixed = applyFixes(text, diags).text;
  assert.match(fixed, /^:::requirement\{#R4 priority=P1\} Missing$/m);
  assert.match(fixed, /^:::requirement\{#R5\} Bare$/m);
  assert.deepEqual(found(fixed, 'requirement/id'), []);
});

test('AC4 (R21): the next id follows the document\'s own prefix, skips taken ids, and starts at R1', () => {
  assert.deepEqual(nextIds(['REQ-10', 'REQ-11'], 'R', new Set(), 1), ['REQ-12']);
  assert.deepEqual(nextIds([], 'R', new Set(), 2), ['R1', 'R2']);
  assert.deepEqual(nextIds(['R1'], 'R', new Set(['R2']), 1), ['R3']);
  assert.deepEqual(nextIds([], 'AC', new Set(), 1), ['AC1']);
  const fixed = applyFixes(v2(':::acceptance{verifies=R1}\n:::\n\n:::requirement{#R1} X\n:::'), found(v2(':::acceptance{verifies=R1}\n:::\n\n:::requirement{#R1} X\n:::'), 'acceptance/id')).text;
  assert.match(fixed, /^:::acceptance\{#AC1 verifies=R1\}$/m);
});

test('AC5 (R22): an accepted requirement no acceptance block verifies is a hint; a nested or listing one covers it', () => {
  const uncovered = found(v2(':::requirement{#R1 status=accepted} X\n:::'), 'requirement/uncovered');
  assert.equal(uncovered.length, 1);
  assert.equal(uncovered[0].severity, 'hint');
  assert.deepEqual(found(v2(':::requirement{#R1 status=proposed} X\n:::'), 'requirement/uncovered'), [], 'proposed is not settled');
  assert.deepEqual(found(SAMPLE, 'requirement/uncovered'), []);
  assert.deepEqual(found(v2(':::requirement{#R1 status=verified} X\n:::\n\n:::acceptance{#AC1 verifies=R1}\n:::'), 'requirement/uncovered'), []);
});

test('R34: an acceptance block that verifies nothing warns; R36: a test path that does not exist warns link/missing-file', () => {
  const lone = found(v2(':::acceptance{#AC1}\nGiven\n:::'), 'acceptance/verifies');
  assert.equal(lone.length, 1);
  assert.equal(lone[0].severity, 'warning');
  assert.deepEqual(found(SAMPLE, 'acceptance/verifies'), []);
  const missing = found(SAMPLE, 'link/missing-file', { fileExists: () => false });
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /"test\/agentView\.test\.ts" does not exist \(the test of acceptance AC1\)/);
  assert.deepEqual(found(SAMPLE, 'link/missing-file', { fileExists: () => true }), []);
  assert.deepEqual(found(SAMPLE, 'link/missing-file'), [], 'no file check without a reader');
});

test('R33: acceptance/verifies-type warns when verifies names a block that is not a requirement', () => {
  const text = v2(':::decision{#D1 status=accepted} X\n:::\n\n## Heading {#H1}\n\n:::acceptance{#AC1 verifies=D1,H1}\n:::');
  const diags = found(text, 'acceptance/verifies-type');
  assert.deepEqual(diags.map((d) => d.message), [
    'verifies names "D1", which is a :::decision. An acceptance block verifies requirements.',
    'verifies names "H1", which is a heading. An acceptance block verifies requirements.',
  ]);
});

test('R30: a constraint above the first heading applies to the whole document (constraint/scope, with a fix)', () => {
  const text = v2(':::constraint{#C1} Above the headings\n:::\n\n## One\n\n:::constraint{#C2} In a section\n:::');
  const diags = found(text, 'constraint/scope');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'info');
  assert.match(applyFixes(text, diags).text, /^:::constraint\{#C1 scope=document\} Above the headings$/m);
});

test('R25: document-wide constraints that cost over 500 tokens together are a hint (constraint/size)', () => {
  const long = 'Word '.repeat(300);
  assert.equal(found(v2(`:::constraint{#C1 scope=document} A\n${long}\n:::\n\n:::constraint{#C2 scope=document} B\n${long}\n:::`), 'constraint/size').length, 1);
  assert.deepEqual(found(v2(`:::constraint{#C1 scope=document} A\n${long}\n:::`), 'constraint/size'), []);
});

test('R63: no new diagnostic is an error', () => {
  const text = v2(':::requirement{status=accepted} X\n:::\n\n:::acceptance\n:::\n\n:::constraint Y\n:::\n\n## H');
  assert.deepEqual(validateSmd(text, { fileExists: () => false }).filter((d) => d.severity === 'error'), []);
});

test('R6: the tags are query types, attributes are keys, and defaults come from the spec', () => {
  assert.deepEqual(querySmd(SAMPLE, 'requirement[priority=P0]').map((m) => m.attrs.id), ['R1']);
  assert.deepEqual(querySmd(SAMPLE, 'requirement[status=proposed]').map((m) => m.attrs.id), ['R2']);
  assert.deepEqual(querySmd(SAMPLE, 'constraint[scope=document]').map((m) => m.attrs.id), ['C1']);
  assert.deepEqual(querySmd(SAMPLE, 'constraint[level=must]').map((m) => m.attrs.id), ['C1']);
  assert.deepEqual(querySmd(SAMPLE, 'constraint[applies-to=R1]').map((m) => m.attrs.id), ['C2']);
  assert.match(querySmd(SAMPLE, 'requirement[id=R2]')[0].text, /^<requirement id="R2" status="proposed"> Views stay small/);
  assert.equal(querySmd(SAMPLE, 'requirement[id=R2]')[0].attrs.status, 'proposed');
});

test('R7: catalog entries count the tags, and only when a document has them', () => {
  assert.deepEqual(indexEntry(SAMPLE, 'spec.smd', { today: TODAY }).counts.tags, { requirement: 2, constraint: 2, acceptance: 2 });
  assert.equal('tags' in indexEntry(v2('## Plain\n\nText.'), 'plain.smd', { today: TODAY }).counts, false);
});

test('R11: smd fmt writes the id first, then the tag\'s attributes in its table order', () => {
  const text = v2(':::requirement{owner=@a status=accepted #R1 priority=P0} X\n:::\n\n:::constraint{level=should applies-to=R1 #C1 scope=section} Y\n:::\n\n:::acceptance{test="a.ts" verifies=R1 #AC1}\n:::');
  const out = formatSmd(text);
  assert.match(out, /^:::requirement\{#R1 priority=P0 status=accepted owner=@a\} X$/m);
  assert.match(out, /^:::constraint\{#C1 scope=section applies-to=R1 level=should\} Y$/m);
  assert.match(out, /^:::acceptance\{#AC1 verifies=R1 test=a\.ts\}$/m);
  assert.equal(formatSmd(out), out);
});

test('R23: a settled requirement is key content under a budget, and brief views condense a deprecated one', () => {
  const filler = 'Filler words here. '.repeat(60);
  const text = v2(`## Plain\n\n${filler}\n\n## Settled\n\n:::requirement{#R1 status=accepted} Keep me\n${filler}\n:::\n\n## Old\n\n:::requirement{#R9 status=deprecated} Old rule\nLong body.\n:::`);
  // The settled section is the larger, so it goes first unless it holds key content. The budget leaves room for one omission.
  const omitted = (doc: string) => agentView(doc, { maxTokens: agentView(doc).tokens - 100 }).budget!.omitted.map((o) => o.heading);
  assert.deepEqual(omitted(text.replace('## Old', '## Old {agent=skip}')), ['Plain']);
  assert.deepEqual(omitted(text.replace('## Old', '## Old {agent=skip}').replace('status=accepted', 'status=proposed')), ['Settled']);
  const brief = agentView(text, { brief: true }).text;
  assert.match(brief, /^\[requirement R9 \(deprecated\): Old rule — omitted, see L\d+\]$/m);
  assert.doesNotMatch(brief, /Long body/);
  assert.match(agentView(text).text, /Long body/);
});

test('R8: symbols list the tags; completion offers ids for id attributes; hover shows the defaults', () => {
  const symbols = documentSymbols(SAMPLE).filter((s) => s.kind !== 'heading');
  assert.deepEqual(symbols.map((s) => `${s.kind} ${s.name} (${s.detail})`), [
    'constraint C1 — Included files stay inside the workspace (must)',
    'requirement R1 — Section reads keep applicable instructions (P0 · accepted)',
    'acceptance AC1 ()',
    'requirement R2 — Views stay small (proposed)',
    'constraint C2 — Keep views under 2,000 tokens (should)',
    'acceptance AC2 (verifies R2,R1)',
  ]);
  assert.match(outline(SAMPLE), /## Requirements.*requirement, constraint/);
  const text = `${SAMPLE}\n:::acceptance{#AC3 verifies=R1,}\n:::\n`;
  const line = text.split('\n').findIndex((l) => l.startsWith(':::acceptance{#AC3'));
  const items = completionsAt(text, line, ':::acceptance{#AC3 verifies=R1,'.length);
  assert.deepEqual(items?.items.map((i) => i.label), ['R1', 'R2'], 'requirement ids only, for verifies');
  const hover = hoverAt(SAMPLE, SAMPLE.split('\n').findIndex((l) => l.startsWith(':::requirement{#R2')), 5);
  assert.match(hover?.markdown ?? '', /Defaults: `status=proposed`/);
});

test('R24, R32, R37: the spec and PRD templates use requirement, acceptance and constraint blocks with ids written', () => {
  const dir = join(__dirname, '..', '..', 'skills', 'semantic-markdown-writer', 'assets', 'templates');
  const spec = fillTemplate(readFileSync(join(dir, 'spec.smd'), 'utf8'), 'Example', TODAY);
  assert.match(spec, /^:::requirement\{#R1 priority=P0 status=proposed\} /m);
  assert.match(spec, /^:::acceptance\{#AC1 verifies=R1\}$/m);
  assert.match(spec, /^:::constraint\{#C1 scope=document\} /m);
  assert.doesNotMatch(spec, /^\| (?:ID|R1|AC1) /m, 'no requirement or acceptance tables');
  assert.doesNotMatch(spec, /:::warning Constraint/);
  const prd = fillTemplate(readFileSync(join(dir, 'prd.smd'), 'utf8'), 'Example', TODAY);
  assert.match(prd, /^:::requirement\{#R1 priority=P0 status=proposed owner=@owner\} /m);
  for (const doc of [spec, prd]) {
    assert.deepEqual(validateSmd(doc, { today: TODAY }).filter((d) => d.severity === 'error' || d.severity === 'warning'), []);
    assert.equal(formatSmd(doc), doc);
  }
});
