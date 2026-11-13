import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView } from '../src/core';
import type { BlockAccount } from '../src/core/accounting';
import { protectedRows } from '../src/omissionPanel';

/**
 * Block accounting (improvement roadmap t-67, view laws L6 target form): every block of the source has exactly one
 * outcome per view, with where it appears recorded apart.
 */

const DOC = [
  '---', 'smd: 2', 'title: Plan', '---', '',
  ':::agent', 'AGENT_TEXT', ':::', '',
  '## Work', '', 'Work text.', '',
  '::::details More', 'Detail text.', '', ':::danger', 'DANGER_IN_DETAILS', ':::', '::::', '',
  '## Rules', '', ':::constraint{#C1 scope=document} Workspace only', 'C1_BODY', ':::', '', 'Rules text.', '',
  '## Notes {agent=skip}', '', 'For people.', '',
  ':::include{file="gone.smd"}', ':::', '',
].join('\n');

const view = (options: Record<string, unknown>) => agentView(DOC, { ...options, provenance: true, file: 'plan.smd', readFile: () => undefined }).provenance!;
const at = (blocks: readonly BlockAccount[], line: number) => blocks.find((b) => b.lines[0] === line)!;

test('t-67: each block of the source has exactly one outcome, and the blocks cover every line after the front matter', () => {
  for (const options of [{}, { brief: true }, { sections: ['Work'] }, { sections: ['Rules'], brief: true }, { maxTokens: 40 }]) {
    const blocks = view(options).blocks;
    assert.ok(blocks.every((b) => b.outcome !== 'unaccounted'), JSON.stringify(options));
    const lines = DOC.split('\n');
    for (let l = 5; l < lines.length; l++) {
      if (lines[l].trim()) assert.ok(blocks.some((b) => l + 1 >= b.lines[0] && l + 1 <= b.lines[1]), `line ${l + 1} in ${JSON.stringify(options)}`);
    }
  }
});

test('t-67: a danger kept out of a condensed details block is carried, placed in the body, and the details block is condensed', () => {
  const blocks = view({ brief: true }).blocks;
  const details = at(blocks, 14);
  const danger = at(blocks, 17);
  assert.deepEqual([details.kind, details.outcome, details.omission?.kind], ['details', 'condensed', 'details']);
  assert.deepEqual([danger.kind, danger.outcome, danger.placement], ['danger', 'carried', 'body']);
  assert.equal(blocks[danger.parent!], details);
});

test('t-67: a section read shows its own blocks, carries the rules and agent blocks of others, and omits the rest with a reason', () => {
  const blocks = view({ sections: ['Work'] }).blocks;
  assert.deepEqual([at(blocks, 10).outcome, at(blocks, 12).outcome], ['shown', 'shown']);
  assert.deepEqual([at(blocks, 6).kind, at(blocks, 6).outcome, at(blocks, 6).placement], ['agent', 'carried', 'head']);
  assert.deepEqual([at(blocks, 24).kind, at(blocks, 24).outcome, at(blocks, 24).placement], ['constraint', 'carried', 'head']);
  assert.deepEqual([at(blocks, 28).outcome, at(blocks, 28).omission?.kind], ['omitted', 'not-selected']);
  assert.deepEqual([at(blocks, 30).outcome, at(blocks, 30).omission?.kind], ['omitted', 'not-selected']);
  // The include sits in a section for people: omitted with it, and unavailable once that section is named and read.
  assert.deepEqual([at(view({}).blocks, 34).outcome, at(view({}).blocks, 34).omission?.kind], ['omitted', 'skipped-section']);
  assert.equal(at(view({ sections: ['Notes'] }).blocks, 34).outcome, 'unavailable');
});

test('t-67: the whole view puts a skipped section\'s blocks down as omitted for people, and shows the rest', () => {
  const blocks = view({}).blocks;
  assert.deepEqual([at(blocks, 30).outcome, at(blocks, 30).omission?.kind], ['omitted', 'skipped-section']);
  assert.deepEqual([at(blocks, 24).outcome, at(blocks, 24).placement], ['shown', 'body']);
});

test('t-67: the omission panel builds a matrix of sections against protected blocks from the same data', () => {
  const rows = protectedRows(view({ sections: ['Work'], brief: true }));
  assert.deepEqual(rows.map((r) => [r.section, r.blocks.map((b) => `${b.label}:${b.outcome}`)]), [
    ['(before the first heading)', ['agent:carried']],
    ['Work', ['danger:carried']],
    ['Rules', ['constraint C1:carried']],
  ]);
});

test('t-67: the view reads fences and comments as rendering does, so no selected heading is lost', () => {
  const read = (text: string, sections: string[]) => agentView(text, { sections, provenance: true });
  // A backtick in a backtick fence's info string makes it text, not a fence.
  assert.match(read('```>`\n## Section\n\nText.\n', ['Section']).text, /## Section/);
  // A fence-like line inside a raw HTML block is HTML text.
  assert.match(read('</div>\n```ts\n\n## Section\n\nText.\n', ['Section']).text, /## Section {2}\[L4\]/);
  // A comment never closed inside a container ends with the container.
  assert.match(read(':::details More\n<!-- note\n:::\n## Open\n\nQ.\n', ['Open']).text, /## Open {2}\[L4\]/);
  // A fence-like line inside display math is math.
  assert.match(read('$$\n````\n$$\n# Title\n\nT.\n', ['Title']).text, /# Title {2}\[L4\]/);
  for (const text of ['```>`\n## Section\n', '</div>\n```ts\n\n## Section\n', '$$\n````\n$$\n# Title\n']) {
    assert.ok(read(text, ['Section', 'Title']).provenance!.blocks.every((b) => b.outcome !== 'unaccounted'), text);
  }
});
