import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, indexEntry, outline, querySmd, renderSmd, smdToMarkdown, validateSmd } from '../src/core';
import { documentSymbols } from '../src/core/symbols';

/**
 * Semantic tags phase 3 (docs/rfcs/semantic-tags.smd, "Phase 3", D10 and D11): non-goals, examples, limitations,
 * deprecated content and `:since`. Test names give the requirement ids of docs/requirements/semantic-tags.smd.
 */

const TODAY = '2026-11-08';
const v2 = (body: string) => `---\nsmd: 2\ntitle: T\n---\n\n${body}\n`;
const v1 = (body: string) => `---\nsmd: 1\ntitle: T\n---\n\n${body}\n`;
const found = (text: string, code: string) => validateSmd(text, { today: TODAY }).filter((d) => d.code === code);
const filler = 'Filler words here. '.repeat(60);

// --- Non-goals -----------------------------------------------------------------------------------------------------

const NON_GOALS = ':::non-goals\n- No requirements tool.\n- No test runner.\n:::';

test('R57: :::non-goals renders as a panel, <non-goals> in the agent view and an IMPORTANT alert in plain Markdown', () => {
  const text = v2(`## Scope\n\n${NON_GOALS}`);
  const html = renderSmd(text, { today: TODAY }).html;
  assert.match(html, /<div class="smd-block smd-non-goals"[^>]*><div class="smd-block-head"><span class="smd-block-kind">Non-goals<\/span><\/div>/);
  assert.match(agentView(text).text, /^<non-goals>\n- No requirements tool\.\n- No test runner\.\n<\/non-goals>$/m);
  assert.match(smdToMarkdown(text), /^> \[!IMPORTANT\]\n> \*\*Non-goals\*\*\n>\n> - No requirements tool\.$/m);
  assert.deepEqual(validateSmd(text, { today: TODAY }), []);
});

test('R57: a section view that leaves out the non-goals still shows them, as it shows :::agent blocks', () => {
  const text = v2(`## Goals\n\n${NON_GOALS}\n\n## Design\n\nThe design.`);
  const view = agentView(text, { sections: ['Design'] }).text;
  assert.match(view, /Document-wide agent instructions:\n<non-goals>\n- No requirements tool\./);
  assert.match(agentView(text, { sections: ['Design'], brief: true }).text, /No test runner/);
});

test('R57: a budget never omits the section that holds non-goals', () => {
  // The non-goals section is the larger, so it would go first if it could be omitted.
  const text = v2(`## Plain\n\n${filler}\n\n## Scope\n\n:::non-goals\n- One.\n:::\n\n${filler}${filler}`);
  const result = agentView(text, { maxTokens: 200 });
  assert.deepEqual(result.budget!.omitted.map((o) => o.heading), ['Plain']);
  assert.match(result.text, /<non-goals>\n- One\./);
});

test('R57: non-goals written as prose get the hint non-goals/list', () => {
  const diags = found(v2(':::non-goals\nWe will not build a tool.\n:::'), 'non-goals/list');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'hint');
  assert.deepEqual(found(v2(NON_GOALS), 'non-goals/list'), []);
  assert.deepEqual(found(v2(':::non-goals\n1. Numbered.\n:::'), 'non-goals/list'), []);
});

// --- Examples ------------------------------------------------------------------------------------------------------

test('R58: a bad example says kind="dont" in the agent view, a red "don\'t" pill in HTML and CAUTION in plain Markdown', () => {
  const text = v2(':::example{kind=dont} Spell the id as an attribute\n`id=R1`\n:::\n\n:::example{kind=do} Use an id\n`{#R1}`\n:::\n\n:::example\nNeutral.\n:::');
  const view = agentView(text).text;
  assert.match(view, /^<example kind="dont"> Spell the id as an attribute$/m);
  assert.match(view, /^<example kind="do"> Use an id$/m);
  assert.match(view, /^<example>\nNeutral\.\n<\/example>$/m);
  const html = renderSmd(text, { today: TODAY }).html;
  assert.match(html, /class="smd-block smd-example smd-example-dont"/);
  assert.match(html, /<span class="smd-pill smd-pill-kind smd-pill-kind-dont">don't<\/span>/);
  const md = smdToMarkdown(text);
  assert.match(md, /^> \[!CAUTION\]\n> \*\*Example\*\* · don't$/m);
  assert.match(md, /^> \[!TIP\]\n> \*\*Example\*\* · do$/m);
  assert.match(md, /^> \[!NOTE\]\n> \*\*Example\*\*\n>\n> Neutral\.$/m);
});

test('R58: an invalid kind is a warning, not an error', () => {
  const diags = found(v2(':::example{kind=maybe}\nX\n:::'), 'attrs/value');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'warning');
});

// --- Limitations ---------------------------------------------------------------------------------------------------

test('R70: a limitation is open by default, links what it affects and is a WARNING until resolved', () => {
  const text = v2(':::requirement{#R1} Export\n:::\n\n:::limitation{#L1 affects=R1 owner=@team} PDF needs a browser\nWorkaround.\n:::');
  assert.match(agentView(text).text, /^<limitation id="L1" status="open" affects="R1" owner="@team"> PDF needs a browser$/m);
  const html = renderSmd(text, { today: TODAY }).html;
  assert.match(html, /<span class="smd-pill smd-pill-status smd-pill-status-open">open<\/span>/);
  assert.match(html, /affects <a class="smd-ref" href="#R1"/);
  assert.match(smdToMarkdown(text), /^> \[!WARNING\]\n> \*\*Limitation L1\*\* · open · affects R1 · @team$/m);
  assert.match(smdToMarkdown(text.replace('affects=R1', 'status=resolved affects=R1')), /^> \[!NOTE\]\n> \*\*Limitation L1\*\* · resolved/m);
  assert.deepEqual(querySmd(text, 'limitation[status=open]').map((m) => m.attrs.id), ['L1']);
});

test('R70: affects is an id attribute, checked by ref/unknown', () => {
  const diags = found(v2(':::limitation{affects=R9} Gone\n:::'), 'ref/unknown');
  assert.equal(diags.length, 1);
});

test('R70: a limitation that is not resolved is key content under a budget', () => {
  const doc = (status: string) => v2(`## Plain\n\n${filler}\n\n## Known issues\n\n:::limitation{#L1${status}} Slow\n${filler}\n:::`);
  const omitted = (text: string) => agentView(text, { maxTokens: agentView(text).tokens - 100 }).budget!.omitted.map((o) => o.heading);
  assert.deepEqual(omitted(doc('')), ['Plain'], 'an open limitation is kept longer');
  assert.deepEqual(omitted(doc(' status=resolved')), ['Known issues'], 'a resolved one is ordinary content');
});

// --- Deprecated and :since -----------------------------------------------------------------------------------------

test('R59: :::deprecated shows since and use on every surface, and smd query filters on since', () => {
  const text = v2(':::deprecated{since=2.0 use="`smd export`"} smd convert\nStill works.\n:::');
  assert.match(agentView(text).text, /^<deprecated since="2\.0" use="`smd export`"> smd convert$/m);
  const html = renderSmd(text, { today: TODAY }).html;
  assert.match(html, /since 2\.0<span class="smd-dot">·<\/span>use <code>smd export<\/code>/);
  assert.match(smdToMarkdown(text), /^> \[!WARNING\]\n> \*\*Deprecated\*\* · since 2\.0 · use `smd export`$/m);
  assert.equal(querySmd(text, 'deprecated[since=2.0]').length, 1);
  assert.equal(querySmd(text, 'deprecated[since=3.0]').length, 0);
});

test('R59: :since[1.6] renders a version label in spec v2', () => {
  const text = v2('Added :since[1.6] here.');
  assert.match(renderSmd(text, { today: TODAY }).html, /Added <span class="smd-since">since 1\.6<\/span> here\./);
  assert.match(agentView(text).text, /^Added \(since 1\.6\) here\.$/m);
  assert.match(smdToMarkdown(text), /^Added \(since 1\.6\) here\.$/m);
  assert.deepEqual(found(text, 'directive/unknown'), []);
});

test('AC17 (R61): in spec v1 :since stays text', () => {
  const text = v1('Added :since[1.6] here.');
  assert.match(renderSmd(text, { today: TODAY }).html, /Added :since\[1\.6\] here\./);
  assert.match(smdToMarkdown(text), /Added :since\[1\.6\] here\./);
});

test('R58 (de): the labels follow lang', () => {
  const text = `---\nsmd: 2\ntitle: T\nlang: de\n---\n\n:::example{kind=dont}\nX\n:::\n\n:::deprecated{since=2.0}\nY\n:::\n`;
  const html = renderSmd(text, { today: TODAY }).html;
  assert.match(html, /<span class="smd-block-kind">Beispiel<\/span>/);
  assert.match(html, />falsch<\/span>/);
  assert.match(html, /seit 2\.0/);
});

// --- Outline, symbols, catalog -------------------------------------------------------------------------------------

test('phase 3: the outline notes non-goals, limitations and deprecated content; symbols leave examples out', () => {
  const text = v2(`## Scope\n\n${NON_GOALS}\n\n## Issues\n\n:::limitation{#L1} Slow\n:::\n\n## Old\n\n:::deprecated{since=2.0} Old API\n:::\n\n:::example{kind=do} E\n:::`);
  const out = outline(text);
  assert.match(out, /## Scope\s+≈\d+\s+non-goals/);
  assert.match(out, /## Issues\s+≈\d+\s+limitation/);
  assert.match(out, /## Old\s+≈\d+\s+deprecated/);
  const kinds = documentSymbols(text).filter((s) => s.kind !== 'heading').map((s) => `${s.kind}:${s.name}:${s.detail}`);
  assert.deepEqual(kinds, ['non-goals:non-goals:', 'limitation:L1 — Slow:open', 'deprecated:Old API:since 2.0']);
  assert.deepEqual(indexEntry(text, 't.smd', { today: TODAY }).counts.tags, { 'non-goals': 1, example: 1, limitation: 1, deprecated: 1 });
});

test('R63: documents without the phase 3 tags read as before (no outline note, no tags count)', () => {
  const text = v2('## A\n\nText with an example and a limitation in words.');
  assert.doesNotMatch(outline(text), /non-goals|limitation|deprecated/);
  assert.equal(indexEntry(text, 't.smd', { today: TODAY }).counts.tags, undefined);
});
