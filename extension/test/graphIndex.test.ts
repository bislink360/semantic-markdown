import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { contains, DocumentGraph, innermostBlocks, nodeKey, type GraphDocument, type GraphEdge, type GraphNode } from '../src/core/graph';
import { documentBlocks } from '../src/core/query';

/**
 * The document graph's indexes (improvement roadmap t-17, CL-11) answer as the scans they replace did: each lookup is
 * compared with a plain scan, on every document of the corpora and on random block layouts.
 */

const TODAY = '2026-11-01';
const root = join(__dirname, '..', '..');
const FOLDERS = ['extension/test/compat/corpus', 'research/data/corpus', 'extension/test/snapshots/fixtures', 'extension/test/conformance/cases', 'extension/test/editor/workspace'];

/** The tracked .smd files of the corpora, grouped by folder, so links between neighbors resolve. */
function folders(): GraphDocument[][] {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...FOLDERS], { cwd: root, encoding: 'utf8' }); // NOSONAR(typescript:S4036): the maintainer's or CI runner's own git, as the snapshot harness runs it
  const groups = new Map<string, GraphDocument[]>();
  for (const path of listed.stdout.split('\0').filter((f) => f.endsWith('.smd'))) {
    const group = groups.get(dirname(path)) ?? [];
    group.push({ path, text: fs.readFileSync(join(root, path), 'utf8') });
    groups.set(dirname(path), group);
  }
  return [...groups.values()];
}

const graphOf = (docs: readonly GraphDocument[]) => new DocumentGraph(docs, {
  today: TODAY,
  readDocument: (path) => (fs.existsSync(join(root, path)) ? { text: fs.readFileSync(join(root, path), 'utf8') } : { status: 'missing' }),
});

/** The scans the indexes replace. */
const scanIncoming = (g: DocumentGraph, node: GraphNode) => g.allEdges().filter((e) => e.to && nodeKey(e.to) === nodeKey(node));
const scanAppliesTo = (g: DocumentGraph, node: GraphNode) => g.allEdges().filter((e) => e.type === 'applies-to' && e.to && e.to.type !== 'document' && contains(e.to, node));

function scanInnermost(blocks: ReadonlyArray<{ line: number; endLine: number }>, line: number): number {
  let best = -1;
  blocks.forEach((b, i) => {
    if (b.line <= line && line <= b.endLine && (best < 0 || b.line >= blocks[best].line)) best = i;
  });
  return best;
}

test('t-17: the innermost block of a line is the one that starts last, and of those the last listed', () => {
  const blocks = [{ line: 0, endLine: 9 }, { line: 2, endLine: 6 }, { line: 2, endLine: 4 }, { line: 8, endLine: 8 }];
  assert.deepEqual([...innermostBlocks(blocks, 11)], [0, 0, 2, 2, 2, 1, 1, 0, 3, 0, -1]);
  assert.deepEqual([...innermostBlocks([], 2)], [-1, -1]);
  assert.deepEqual([...innermostBlocks([{ line: 3, endLine: 1 }], 5)], [-1, -1, -1, -1, -1], 'a block that ends before it starts holds nothing');
});

test('t-17: the innermost block matches a scan on random layouts, nested, overlapping, tied and out of order', () => {
  let seed = 20261117;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 8) % n;
  };
  for (let round = 0; round < 300; round++) {
    const lines = 1 + random(60);
    const blocks = Array.from({ length: random(25) }, () => {
      const line = random(lines + 3);
      return { line, endLine: line + random(20) - 2 };
    });
    const table = innermostBlocks(blocks, lines);
    for (let l = 0; l < lines; l++) assert.equal(table[l], scanInnermost(blocks, l), `round ${round}, line ${l}: ${JSON.stringify(blocks)}`);
  }
});

test('t-17: nodeAt finds a block only on the line it starts on', () => {
  const text = '---\nsmd: 2\n---\n\n## Work\n\n:::requirement{#R1} Refund\nBody.\n:::\n';
  const g = new DocumentGraph([{ path: 'a.smd', text }], { today: TODAY });
  assert.equal(g.nodeAt('a.smd', 6)?.id, 'R1');
  assert.equal(g.nodeAt('a.smd', 7), undefined, 'a line inside the block is not its start');
  assert.equal(g.nodeAt('a.smd', 4)?.type, 'heading');
  assert.equal(g.nodeAt('missing.smd', 0), undefined);
});

test('t-17: when two blocks start on one line, nodeAt gives the first listed', () => {
  // A task underlined as a heading: one line, two blocks.
  const text = '---\nsmd: 2\n---\n\n- [ ] Build the service\n  ---\n';
  const blocks = documentBlocks(text, TODAY).filter((b) => b.line === 4);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'task'], 'the layout this test is about');
  assert.equal(new DocumentGraph([{ path: 'a.smd', text }], { today: TODAY }).nodeAt('a.smd', 4)?.type, 'heading');
});

test('t-17: incoming edges come from the given documents only, also once another document has been reached', () => {
  const a = '---\nsmd: 2\n---\n\n:::requirement{#A1 depends-on=b.smd#B1} First\n:::\n';
  const b = '---\nsmd: 2\n---\n\n:::requirement{#B1 depends-on=a.smd#A1} Second\n:::\n';
  const g = new DocumentGraph([{ path: 'a.smd', text: a }], { today: TODAY, readDocument: (p) => (p === 'b.smd' ? { text: b } : { status: 'missing' }) });
  const inB = g.nodeAt('b.smd', 4)!;
  const inA = g.nodeAt('a.smd', 4)!;
  assert.deepEqual(g.incoming(inB).map((e: GraphEdge) => e.from.id), ['A1'], 'a lazily reached document is a target');
  assert.deepEqual(g.incoming(inA), [], 'its own edges are not counted: it was not given');
  assert.deepEqual(g.edgesOf('b.smd').map((e) => e.to?.id), ['A1'], 'they exist when asked for');
  assert.deepEqual(g.incoming(inA), [], 'and asking does not add them');
  const first = g.incoming(inB);
  first.length = 0;
  assert.equal(g.incoming(inB).length, 1, 'a caller cannot change the index');
});

test('t-17: rules apply to what their target holds, in its own document only', () => {
  const a = [
    '---', 'smd: 2', '---', '', ':::constraint{#C1 applies-to=work} Log every change', ':::', '',
    '## Work {#work}', '', ':::requirement{#R1} Inside', ':::', '', '## Other', '', ':::requirement{#R2} Outside', ':::', '',
  ].join('\n');
  const b = '---\nsmd: 2\n---\n\n:::requirement{#R3} Elsewhere\n:::\n';
  const g = new DocumentGraph([{ path: 'a.smd', text: a }, { path: 'b.smd', text: b }], { today: TODAY });
  assert.deepEqual(g.appliesTo(g.nodeAt('a.smd', 9)!).map((e) => e.from.id), ['C1']);
  assert.deepEqual(g.appliesTo(g.nodeAt('a.smd', 14)!), []);
  assert.deepEqual(g.appliesTo(g.nodeAt('b.smd', 4)!), []);
  assert.deepEqual(g.appliesTo(g.documentNode('a.smd')!), [], 'a whole document is not inside a heading');
});

test('t-17: a rule written in one document binds what it names in another, and nothing where it is written', () => {
  const rules = '---\nsmd: 2\n---\n\n:::constraint{#C1 applies-to=spec.smd#work} Log every change\n:::\n\n:::requirement{#R9} Beside the rule\n:::\n';
  const spec = '---\nsmd: 2\n---\n\n## Work {#work}\n\n:::requirement{#R1} Inside\n:::\n';
  const g = new DocumentGraph([{ path: 'rules.smd', text: rules }, { path: 'spec.smd', text: spec }], { today: TODAY });
  assert.deepEqual(g.appliesTo(g.nodeAt('spec.smd', 6)!).map((e) => e.from.id), ['C1']);
  assert.deepEqual(g.appliesTo(g.nodeAt('rules.smd', 7)!), []);
});

test('t-17: on every document of the corpora the indexes answer as the scans do, in the same order', { timeout: 120_000 }, () => {
  let blocks = 0;
  let sources = 0;
  for (const docs of folders()) {
    const g = graphOf(docs);
    for (const { path, text } of docs) {
      const all = documentBlocks(text, TODAY);
      for (const b of all) {
        blocks++;
        const node = g.nodeAt(path, b.line)!;
        assert.equal(node.line, all.find((x) => x.line === b.line)!.line, `${path}:${b.line}`);
        assert.equal(node.type, all.find((x) => x.line === b.line)!.type, `${path}:${b.line}: the first block on the line`);
        assert.deepEqual(g.incoming(node), scanIncoming(g, node), `${path}:${b.line} incoming`);
        assert.deepEqual(g.appliesTo(node), scanAppliesTo(g, node), `${path}:${b.line} applies-to`);
      }
      for (const e of g.edgesOf(path)) {
        if (e.type !== 'link' && e.type !== 'ref') continue;
        sources++;
        const inner = all[scanInnermost(all, e.line)];
        assert.deepEqual([e.from.line, e.from.type], inner ? [inner.line, inner.type] : [undefined, 'document'], `${path}:${e.line} source of the edge`);
      }
    }
  }
  assert.ok(blocks > 1000 && sources > 100, `${blocks} blocks and ${sources} edge sources compared`);
});
