// The reference graph and --follow (docs/requirements/tree-and-graph-filtering.smd G1 to G5, S4; research AC-D).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentGraph, edgeTypes, EdgeTypeError, formatQueryResult, mandatoryClosure, queryDocuments, queryResultJson, queryResultSummary,
  validateSmd, type DocumentRead, type GraphDocument,
} from '../src/core';

const TODAY = '2026-11-07';

const A = [
  '---', 'smd: 2', 'title: Plan A', 'related: [b.smd, ../outside.smd, https://example.com/x.smd]', '---',
  '## Requirements', '',
  ':::requirement{#R1 depends-on=R2} Do one',
  'See [the design](#design), [B](b.smd#b-intro) and :ref[R2]. A [picture](x.png) is not an edge.',
  ':::',
  ':::requirement{#R2 depends-on=R3} Do two', ':::',
  ':::requirement{#R3 depends-on=R4} Do three', ':::',
  ':::requirement{#R4 depends-on=R5} Do four', ':::',
  ':::requirement{#R5 depends-on=R6} Do five', ':::',
  ':::requirement{#R6 depends-on=R7} Do six', ':::',
  ':::requirement{#R7} Do seven', ':::',
  ':::constraint{#C1 applies-to=R1} Keep it under 100 ms', ':::',
  ':::acceptance{#AC1 verifies=R1} Given a request, it answers', ':::',
  '## Design', '',
  ':::decision{#D1 status=accepted depends-on=D2} Use the bus', ':::',
  ':::decision{#D2 status=superseded depends-on=D1} Use polling', ':::',
  ':::decision{#D3 status=accepted supersedes=D2 depends-on=NOPE,DUP} Use rules', ':::',
  ':::note{#DUP} One', ':::',
  ':::note{#DUP} Two', ':::',
  '- [ ] Wire it up :depends[R1] {#T1}',
  '```md', '[not a link](#design) :ref[R1]', '```',
  ':::include{file="c.smd"}', ':::',
  ':::include{file="../secret.smd"}', ':::',
  ':::include{file="gone.smd"}', ':::',
  '',
].join('\n');

const B = ['---', 'smd: 2', 'title: Plan B', '---', '## B intro', '', 'Back to [A](a.smd#requirements).', ''].join('\n');
const C = ['---', 'smd: 2', 'title: Shared terms', '---', 'A term means one thing.', ''].join('\n');

const docs: GraphDocument[] = [{ path: 'docs/a.smd', text: A }, { path: 'docs/b.smd', text: B }, { path: 'docs/c.smd', text: C }];
/** Inside docs/ only, as the CLI allows the paths it was given. */
const reader = (path: string): DocumentRead => (path.startsWith('docs/') ? { status: 'missing' } : { status: 'denied' });

test('G1, G2: edges are derived from links, :ref, related, includes, id attributes and :depends, each typed and directed', () => {
  const graph = new DocumentGraph(docs, { readDocument: reader, today: TODAY });
  const edges = graph.edgesOf('docs/a.smd');
  const summary = edges.map((e) => `${e.from.id ?? e.from.type}:${e.type}(${e.kind})->${e.target}=${e.status}${e.to ? `@${e.to.file}:${e.to.id ?? e.to.type}` : ''}`);
  assert.deepEqual(summary, [
    'document:related(navigation)->b.smd=resolved@docs/b.smd:document',
    'document:related(navigation)->../outside.smd=denied',
    'R1:depends-on(mandatory)->R2=resolved@docs/a.smd:R2',
    'R1:link(navigation)->#design=resolved@docs/a.smd:design',
    'R1:link(navigation)->b.smd#b-intro=resolved@docs/b.smd:b-intro',
    'R1:ref(navigation)->R2=resolved@docs/a.smd:R2',
    'R2:depends-on(mandatory)->R3=resolved@docs/a.smd:R3',
    'R3:depends-on(mandatory)->R4=resolved@docs/a.smd:R4',
    'R4:depends-on(mandatory)->R5=resolved@docs/a.smd:R5',
    'R5:depends-on(mandatory)->R6=resolved@docs/a.smd:R6',
    'R6:depends-on(mandatory)->R7=resolved@docs/a.smd:R7',
    'C1:applies-to(mandatory)->R1=resolved@docs/a.smd:R1',
    'AC1:verifies(evidence)->R1=resolved@docs/a.smd:R1',
    'D1:depends-on(mandatory)->D2=resolved@docs/a.smd:D2',
    'D2:depends-on(mandatory)->D1=resolved@docs/a.smd:D1',
    'D3:depends-on(mandatory)->NOPE=missing',
    'D3:depends-on(mandatory)->DUP=ambiguous',
    'D3:supersedes(lifecycle)->D2=resolved@docs/a.smd:D2',
    'T1:depends-on(mandatory)->R1=resolved@docs/a.smd:R1',
    'include:include(mandatory)->c.smd=resolved@docs/c.smd:document',
    'include:include(mandatory)->../secret.smd=denied',
    'include:include(mandatory)->gone.smd=missing',
  ]);
  // Edges point both ways: what points at R1.
  const r1 = graph.nodeAt('docs/a.smd', edges[2].from.line!)!;
  assert.deepEqual(graph.incoming(r1).map((e) => `${e.from.id}:${e.type}`), ['C1:applies-to', 'AC1:verifies', 'T1:depends-on']);
  // Cross-file: B links back to a heading of A.
  assert.deepEqual(graph.edgesOf('docs/b.smd').map((e) => `${e.type}->${e.to?.file}:${e.to?.id}`), ['link->docs/a.smd:requirements']);
  // An ambiguous target lists the blocks that give the id.
  assert.equal(edges.find((e) => e.target === 'DUP')?.lines?.length, 2);
});

test('G1: :depends is read on tasks in spec v2 only, and the other typed edges come in too', () => {
  const v1 = '---\ntitle: x\n---\n- [ ] T :depends[R1]\n:::note{#R1} r\n:::\n';
  assert.deepEqual(new DocumentGraph([{ path: 'x.smd', text: v1 }]).edgesOf('x.smd').map((e) => e.type), []);
  const typed = [
    '---', 'smd: 2', '---', ':::requirement{#R1} r', ':::',
    ':::evidence{#E1 supports=R1 contradicts=R1} e', ':::',
    ':::question{#Q1 between=R1,E1} q', ':::',
    ':::comment{for=R1} c', ':::',
  ].join('\n');
  const edges = new DocumentGraph([{ path: 't.smd', text: typed }]).edgesOf('t.smd');
  assert.deepEqual(edges.map((e) => `${e.type}:${e.kind}`), ['supports:evidence', 'contradicts:evidence', 'between:lifecycle', 'between:lifecycle', 'for:review']);
});

test('G3: follow lists take edge types, kinds and *, and say what is unknown', () => {
  assert.deepEqual(edgeTypes('supersedes, verifies'), ['verifies', 'supersedes']);
  assert.deepEqual(edgeTypes(['mandatory']), ['include', 'applies-to', 'depends-on']);
  assert.equal(edgeTypes('*').length, 13);
  assert.throws(() => edgeTypes('supercedes'), (e: Error) => e instanceof EdgeTypeError && /Did you mean "supersedes"\?/.test(e.message));
  assert.throws(() => edgeTypes(''), EdgeTypeError);
});

test('AC-D: optional links are pointers, mandatory edges expand to their closure, with cycles, depth cuts and unavailable targets reported', () => {
  const result = queryDocuments(docs, 'requirement[id=R1], decision[id=D1], decision[id=D3], include', {
    follow: '*', direction: 'both', today: TODAY, readDocument: reader,
  });
  assert.deepEqual(result.matches.map((m) => m.attrs.id ?? m.attrs.file), ['R1', 'D1', 'D3', 'c.smd', '../secret.smd', 'gone.smd']);
  const [r1, d1, d3, c, secret, gone] = result.graph!;

  // R1: navigation and evidence neighbors are pointers, with their cost.
  assert.deepEqual(r1.neighbors.map((n) => `${n.direction}:${n.edge.type}:${n.node?.id ?? n.node?.type}`), [
    'out:link:design', 'out:link:b-intro', 'out:ref:R2', 'in:verifies:AC1', 'in:depends-on:T1',
  ]);
  assert.ok(r1.neighbors.find((n) => n.edge.type === 'link' && n.node?.id === 'b-intro')!.tokens > 0);
  // The ref to R2 points at a dependency that is included in full, so it is not counted as unread.
  assert.equal(r1.neighbors.find((n) => n.edge.type === 'ref')!.shown, true);
  // Mandatory: the constraint that applies to R1, and depends-on to five hops.
  assert.deepEqual(r1.dependencies.map((d) => `${d.node.id}@${d.depth}`), ['R2@1', 'R3@2', 'R4@3', 'R5@4', 'R6@5', 'C1@1']);
  assert.deepEqual(r1.unsatisfied.map((u) => `${u.kind}:${u.edge.target}`), ['depth:R7']);

  // A cycle, reported with its path.
  assert.deepEqual(d1.dependencies.map((d) => d.node.id), ['D2']);
  assert.deepEqual(d1.unsatisfied.map((u) => `${u.kind}:${u.path!.map((n) => n.id).join('>')}`), ['cycle:D1>D2>D1']);
  // A missing and an ambiguous target. Supersedes is a lifecycle pointer, never expanded.
  assert.deepEqual(d3.unsatisfied.map((u) => `${u.kind}:${u.edge.target}`), ['missing:NOPE', 'ambiguous:DUP']);
  assert.ok(d3.neighbors.some((n) => n.edge.type === 'supersedes' && n.node?.id === 'D2'));
  assert.equal(d3.dependencies.length, 0);
  // An include: the file's content comes in; a denied or missing file is unsatisfied, with nothing of it shown.
  assert.match(c.dependencies[0].text, /A term means one thing\./);
  assert.deepEqual(secret.unsatisfied.map((u) => u.kind), ['denied']);
  assert.deepEqual(gone.unsatisfied.map((u) => u.kind), ['missing']);
  assert.equal(result.complete, false);

  const text = formatQueryResult(result);
  assert.match(text, /^ {2}-> link {6} {2}heading {2}Design {2}\[L\d+\] {2}≈\d+ tokens$/m);
  assert.match(text, /^ {2}-> link {6} {2}heading {2}B intro {2}docs\/b\.smd \[L5\] {2}≈\d+ tokens$/m);
  assert.match(text, /^ {2}<- verifies {4}acceptance {2}Given a request, it answers {2}\[L\d+\] {2}§Requirements {2}≈\d+ tokens$/m);
  assert.match(text, /^Dependencies \(mandatory edges, included in full\):$/m);
  assert.match(text, /^Unsatisfied dependency: depends-on "R7" from L\d+ is more than 5 hops from the match \(depth limit\)\.$/m);
  assert.match(text, /^Unsatisfied dependency: depends-on "D1" from L\d+ closes a cycle: D1 → D2 → D1\.$/m);
  assert.match(text, /^Unsatisfied dependency: include "\.\.\/secret\.smd" from L\d+ is in secret\.smd, outside the paths this command may read \(denied\)\.$/m);
  assert.match(text, /the result is incomplete\./);
  assert.match(queryResultSummary(result, 3), /^6 match\(es\) in 1 of 3 file\(s\)\. \d+ neighbor\(s\) as pointers \(≈\d+ tokens not read\)\. \d+ dependencies included \(≈\d+ tokens\)\. ≈\d+ tokens shown\. Incomplete: 6 unsatisfied dependencies\.$/);
});

test('G3: direction picks which edges are followed, and depth goes up to 3 hops', () => {
  const out = queryDocuments(docs, 'requirement[id=R1]', { follow: 'link,verifies', today: TODAY, readDocument: reader }).graph![0];
  assert.deepEqual(out.neighbors.map((n) => `${n.direction}:${n.edge.type}`), ['out:link', 'out:link']);
  const inward = queryDocuments(docs, 'requirement[id=R1]', { follow: 'verifies', direction: 'in', today: TODAY }).graph![0];
  assert.deepEqual(inward.neighbors.map((n) => n.node?.id), ['AC1']);
  // Depth 2: B intro links back to A's Requirements heading.
  const two = queryDocuments(docs, 'requirement[id=R1]', { follow: 'link', depth: 2, today: TODAY, readDocument: reader }).graph![0];
  assert.deepEqual(two.neighbors.map((n) => `${n.depth}:${n.node?.id}`), ['1:design', '1:b-intro', '2:requirements']);
  assert.match(formatQueryResult(queryDocuments(docs, 'requirement[id=R1]', { follow: 'link', depth: 2, today: TODAY })), /^ {4}-> link .*Requirements/m);
  // Depth is clamped to 1..3.
  assert.equal(queryDocuments(docs, 'requirement[id=R1]', { follow: 'link', depth: 9, today: TODAY }).options.depth, 3);
  // Following only navigation edges includes nothing and leaves the result complete.
  const nav = queryDocuments(docs, 'requirement[id=R1]', { follow: 'navigation', today: TODAY });
  assert.deepEqual([nav.graph![0].dependencies.length, nav.complete], [0, true]);
});

test('G5: a file outside the documents given is read through the host, and a denied one never shows its content', () => {
  const onlyA = [docs[0]];
  // Without a reader, other files are denied.
  const denied = queryDocuments(onlyA, 'requirement[id=R1]', { follow: 'link', today: TODAY }).graph![0];
  assert.deepEqual(denied.neighbors.map((n) => `${n.edge.target}=${n.edge.status}:${n.tokens}`), ['#design=resolved:' + denied.neighbors[0].tokens, 'b.smd#b-intro=denied:0']);
  assert.equal(denied.neighbors[1].node, undefined);
  // A host that may read it gives the same pointer as when the file is given.
  const read = queryDocuments(onlyA, 'requirement[id=R1]', { follow: 'link', today: TODAY, readDocument: (p) => (p === 'docs/b.smd' ? { text: B } : { status: 'denied' }) }).graph![0];
  assert.equal(read.neighbors[1].node?.title, 'B intro');
  const text = formatQueryResult(queryDocuments(onlyA, 'requirement[id=R1]', { follow: 'link', today: TODAY }));
  assert.match(text, /-> link {6} {2}denied {2}b\.smd#b-intro {2}\(outside the paths this command may read\)/);
});

test('S4: the JSON result carries the edges, pointers, dependencies and token counts', () => {
  const result = queryDocuments(docs, 'requirement[id=R1], include[file=c.smd]', { follow: '*', today: TODAY, readDocument: reader });
  const json = queryResultJson(result);
  assert.equal(json.matches[0].attrs.id, 'R1');
  assert.ok(Array.isArray(json.matches[0].ancestors));
  assert.ok(json.edges!.some((e) => e.type === 'applies-to' && e.from.id === 'C1' && e.to?.id === 'R1'));
  assert.equal(json.matches[0].dependencies!.length, 6);
  assert.equal(json.complete, false);
  assert.equal(json.tokens.shown, result.tokens.shown);
  assert.ok(result.tokens.pointers > 0 && result.tokens.dependencies > 0);
});

test('mandatoryClosure is reusable on its own, and the same source gives the same result (S3)', () => {
  const graph = new DocumentGraph(docs, { today: TODAY, readDocument: reader });
  const r3 = graph.edgesOf('docs/a.smd').find((e) => e.from.id === 'R3')!.from;
  const closure = mandatoryClosure(graph, [r3], { types: ['depends-on'] });
  assert.deepEqual(closure.blocks.map((b) => b.node.id), ['R4', 'R5', 'R6', 'R7']);
  assert.equal(closure.complete, true);
  assert.deepEqual(mandatoryClosure(graph, [r3], { types: ['depends-on'], maxDepth: 2 }).unsatisfied.map((u) => `${u.kind}:${u.edge.target}`), ['depth:R6']);
  const again = () => JSON.stringify(queryResultJson(queryDocuments(docs, '*', { follow: '*', direction: 'both', depth: 3, today: TODAY, readDocument: reader })));
  assert.equal(again(), again());
});

test('the closure depth limit counts the fewest steps, so a long path walked first does not cut a near dependency', () => {
  // The walk reaches R9 through R2 to R5 (5 steps) before R1's own edge to R9 (1 step). R10 is 2 steps from R1.
  const text = [
    '---', 'smd: 2', 'title: Paths', '---', '## Requirements', '',
    ':::requirement{#R1 depends-on=R2,R9} Start', ':::',
    ':::requirement{#R2 depends-on=R3} Two', ':::',
    ':::requirement{#R3 depends-on=R4} Three', ':::',
    ':::requirement{#R4 depends-on=R5} Four', ':::',
    ':::requirement{#R5 depends-on=R9} Five', ':::',
    ':::requirement{#R9 depends-on=R10} Nine', ':::',
    ':::requirement{#R10} Ten', ':::',
    '',
  ].join('\n');
  const paths: GraphDocument[] = [{ path: 'p.smd', text }];
  const graph = new DocumentGraph(paths, { today: TODAY });
  const r1 = graph.edgesOf('p.smd').find((e) => e.from.id === 'R1')!.from;
  const closure = mandatoryClosure(graph, [r1], { types: ['depends-on'] });
  assert.deepEqual(closure.blocks.map((b) => `${b.node.id}@${b.depth}`), ['R2@1', 'R3@2', 'R4@3', 'R5@4', 'R9@1', 'R10@2']);
  assert.deepEqual(closure.unsatisfied, []);
  assert.equal(closure.complete, true);
  // A dependency that is further than the limit by every path is still cut and reported.
  const short = mandatoryClosure(graph, [r1], { types: ['depends-on'], maxDepth: 1 });
  assert.deepEqual(short.blocks.map((b) => `${b.node.id}@${b.depth}`), ['R2@1', 'R9@1']);
  assert.deepEqual(short.unsatisfied.map((u) => `${u.kind}:${u.edge.target}@${u.depth}`), ['depth:R3@2', 'depth:R10@2']);
  // The query and the section view agree.
  const result = queryDocuments(paths, 'requirement[id=R1]', { follow: 'depends-on', today: TODAY });
  assert.equal(result.complete, true);
  assert.doesNotMatch(formatQueryResult(result), /Unsatisfied dependency/);
});

// G7: the validator rules

const codes = (text: string) => validateSmd(text, { today: TODAY })
  .filter((d) => d.code === 'depends/cycle' || d.code === 'decision/depends-superseded')
  .map((d) => `${d.line}:${d.column}-${d.endColumn}:${d.code}:${d.severity}`);

test('G7: depends/cycle warns once per depends-on or supersedes cycle, at its first block', () => {
  const doc = [
    '---', 'smd: 2', '---',
    ':::requirement{#R1 depends-on=R2} One', ':::',
    ':::requirement{#R2 depends-on=R3} Two', ':::',
    ':::requirement{#R3 depends-on=R1} Three', ':::',
    ':::decision{#D1 supersedes=D2} New', ':::',
    ':::decision{#D2 supersedes=D1} Old', ':::',
    ':::requirement{#R4 depends-on=R4} Self', ':::',
    '- [ ] Task A :depends[TB] {#TA}',
    '- [ ] Task B :depends[TA] {#TB}',
    ':::requirement{#R5 depends-on=R1} Fine', ':::',
  ].join('\n');
  // R1 → R2 → R3 → R1 at R1, D1 ⇄ D2 at D1, R4 on itself, and the two tasks at the first.
  assert.deepEqual(codes(doc), ['3:30-32:depends/cycle:warning', '9:27-29:depends/cycle:warning', '13:30-32:depends/cycle:warning', '15:22-24:depends/cycle:warning']);
  const messages = validateSmd(doc, { today: TODAY }).filter((d) => d.code === 'depends/cycle').map((d) => d.message);
  assert.ok(messages.some((m) => m.includes('R1 → R2 → R3 → R1')));
  assert.ok(messages.some((m) => m.includes('This supersedes chain') && m.includes('D1 → D2 → D1')));
  // No cycle, no warning; the rule can be turned off.
  assert.deepEqual(codes(doc.replace('depends-on=R1} Three', 'depends-on=R5} Three').replace('depends-on=R1} Fine', '} Fine')
    .replace('supersedes=D1} Old', '} Old').replace('depends-on=R4} Self', '} Self').replace(':depends[TA]', '')), []);
  assert.equal(validateSmd(doc, { today: TODAY, rules: { 'depends/*': 'off' } }).filter((d) => d.code === 'depends/cycle').length, 0);
});

test('G7: decision/depends-superseded warns on an accepted decision that depends on a superseded one', () => {
  const doc = [
    '---', 'smd: 2', '---',
    ':::decision{#D1 status=superseded} Old way', ':::',
    ':::decision{#D2 status=accepted depends-on=D1} Builds on the old way', ':::',
    ':::decision{#D3 status=proposed} Replaced without its status', ':::',
    ':::decision{#D4 status=accepted supersedes=D3} Replaces D3', ':::',
    ':::decision{#D5 status=accepted depends-on=D3,D4} Builds on both', ':::',
    ':::decision{#D6 status=proposed depends-on=D1} Only proposed', ':::',
  ].join('\n');
  assert.deepEqual(codes(doc), ['5:43-45:decision/depends-superseded:warning', '11:43-45:decision/depends-superseded:warning']);
  assert.match(validateSmd(doc, { today: TODAY }).find((d) => d.code === 'decision/depends-superseded')!.message, /depends on "D1", which is superseded/);
});
