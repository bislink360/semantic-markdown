import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTAINERS, parseSmd, renderSmd, validateSmd } from '../src/core';
import { blockInlines, childBlocks, exportTree, inlineText, type Block } from '../src/core/exportTree';

/**
 * Titled containers (improvement roadmap t-05, CL-01): `spec.ts` says which containers show their title, and the
 * renderer and the id scan in `parse.ts` agree with it, so an id in a shown title is a link target.
 */

/** One container with `[Span]{#id}` in its title, wrapped in its parent when it needs one. */
function doc(name: string, id: string): string {
  const def = CONTAINERS[name];
  const inner = `:::${name} Title [Span]{#${id}}\nBody.\n:::`;
  const block = def.parent ? `::::${def.parent}\n${inner}\n::::` : inner;
  return `---\nsmd: 2\n---\n\n${block}\n`;
}

const hasHtmlId = (html: string, id: string) => html.includes(`id="${id}"`);

test('t-05: every container the vocabulary titles renders the id in its title, and parseSmd lists it', () => {
  const titled = Object.entries(CONTAINERS).filter(([, def]) => def.title).map(([name]) => name);
  assert.ok(titled.includes('changelog') && titled.includes('risk-matrix'));
  for (const name of titled) {
    const id = `t-${name}`;
    const text = doc(name, id);
    assert.ok(hasHtmlId(renderSmd(text).html, id), `${name} renders its title id`);
    assert.ok(parseSmd(text).ids.has(id), `${name} title id is in parseSmd().ids`);
  }
});

test('t-05: containers the vocabulary does not title show no title id, in the HTML or in parseSmd', () => {
  const untitled = Object.entries(CONTAINERS).filter(([, def]) => !def.title && !def.parent && def.attrs?.includes('file') !== true).map(([name]) => name);
  assert.ok(untitled.includes('box') && untitled.includes('timeline'));
  for (const name of untitled) {
    const id = `t-${name}`;
    const text = doc(name, id);
    assert.equal(hasHtmlId(renderSmd(text).html, id), parseSmd(text).ids.has(id), `${name} agrees`);
    assert.equal(parseSmd(text).ids.has(id), false, `${name} has no title id`);
  }
});

test('t-05: an unknown container still renders its title, with its ids, as before', () => {
  const text = '---\nsmd: 2\n---\n\n:::made-up Title [Span]{#t-unknown}\nBody.\n:::\n';
  assert.ok(hasHtmlId(renderSmd(text).html, 't-unknown'));
  assert.ok(parseSmd(text).ids.has('t-unknown'));
});

test('t-05: a link to an id in a changelog or risk-matrix title no longer raises link/missing-anchor', () => {
  for (const name of ['changelog', 'risk-matrix']) {
    const text = `${doc(name, `t-${name}`)}\nSee [it](#t-${name}).\n`;
    const codes = validateSmd(text).map((d) => d.code);
    assert.ok(!codes.includes('link/missing-anchor'), `${name}: ${codes.join(', ')}`);
  }
});

test('t-05: the export keeps the changelog and risk-matrix titles as text (ids are not exported)', () => {
  const all = (blocks: Block[]): Block[] => blocks.flatMap((b) => [b, ...all(childBlocks(b))]);
  for (const name of ['changelog', 'risk-matrix']) {
    const blocks = all(exportTree(doc(name, `t-${name}`)).blocks);
    const text = blocks.map((b) => ('title' in b && typeof b.title === 'string' ? b.title : '') + blockInlines(b).map(inlineText).join(' ')).join(' ');
    assert.match(text, /Title Span/, name);
  }
});
