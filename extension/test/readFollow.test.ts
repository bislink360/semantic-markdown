// smd read --follow and readSmd's follow options (docs/requirements/tree-and-graph-filtering.smd G3 to G5, S2, S4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeTypeError, readSmd, type DocumentRead, type ReadOptions } from '../src/core';
import { readDocument } from '../src/readView';
import { followOptions, runQuery } from '../src/queryCommand';

const TODAY = '2026-11-07';

const A = [
  '---', 'smd: 2', 'title: Plan A', 'related: [b.smd]', '---',
  'Intro links to [B](b.smd).', '',
  '## Requirements', '',
  ':::requirement{#R1 depends-on=R2} Do one',
  'See [the design](#design), [B](b.smd#b-intro) and :ref[R2].',
  ':::', '',
  ':::requirement{#R2} Do two', ':::', '',
  ':::acceptance{#AC1 verifies=R1} Given a request, it answers', ':::', '',
  '## Design', '',
  ':::decision{#D3 status=accepted depends-on=NOPE} Use rules',
  'Uses [secret](../secret.smd).',
  ':::', '',
  ':::constraint{#C2 applies-to=requirements} Keep requirements testable', ':::', '',
  ':::include{file="c.smd"}', ':::', '',
  ':::include{file="../secret.smd"}', ':::', '',
  '## Hidden {agent=skip}', '',
  'Private [link](b.smd#b-intro) and [design](#design).',
  '',
].join('\n');
const B = ['---', 'smd: 2', 'title: Plan B', '---', '## B intro', '', 'Back to [A](a.smd#requirements).', ''].join('\n');
const C = ['---', 'smd: 2', 'title: Shared terms', '---', 'A term means one thing.', ''].join('\n');
/** No constraints and no depends-on: the view reports nothing of its own about its includes. */
const D = [
  '---', 'smd: 2', 'title: Plain', '---', '## Part', '',
  ':::include{file="../secret.smd"}', ':::', '',
  ':::include{file="c.smd"}', ':::', '',
  'See [B](b.smd).', '',
].join('\n');

/** Inside docs/ only, as the CLI allows the document's folder. */
const reader = (p: string): DocumentRead => (p === 'docs/b.smd' ? { text: B } : p === 'docs/c.smd' ? { text: C } : p.startsWith('docs/') ? { status: 'missing' } : { status: 'denied' });
const readFile = (p: string) => (p === 'c.smd' ? C : undefined);
const base: ReadOptions = { file: 'docs/a.smd', today: TODAY, readFile };

test('without follow, a read is what it was: no follow field and no followed edges', () => {
  for (const options of [base, { ...base, sections: ['Requirements'] }, { ...base, mode: 'outline' as const }]) {
    const result = readSmd(A, options);
    assert.equal(result.follow, undefined);
    assert.doesNotMatch(result.text, /Edges followed/);
    assert.deepEqual(readDocument(A, options), result, 'the CLI and MCP name for the same function');
  }
});

test('G3, G4: a section read lists the neighbors of its content as pointers, never the content it shows or hides', () => {
  const result = readSmd(A, { ...base, sections: ['Requirements'], follow: '*', readDocument: reader });
  const view = readSmd(A, { ...base, sections: ['Requirements'] });
  assert.ok(result.text.startsWith(view.text), 'the view comes first, unchanged');
  const follow = result.follow!;
  // The link to Design and the cross-file link; the ref to R2 and R1's depends-on stay inside the section.
  assert.deepEqual(follow.neighbors.map((n) => `${n.direction}:${n.edge.type}:${n.node?.id}`), ['out:link:design', 'out:link:b-intro']);
  assert.match(result.text, /^Edges followed from this content \(\*; out; depth 1\):$/m);
  assert.match(result.text, /^ {2}-> link {8}heading {2}Design {2}\[L20\] {2}≈\d+ tokens$/m);
  assert.match(result.text, /^ {2}-> link {8}heading {2}B intro {2}docs\/b\.smd \[L5\] {2}≈\d+ tokens$/m);
  // The view itself reports the include it could not read, so following edges does not make the result complete.
  assert.equal(result.mandatory?.complete, false);
  assert.equal(follow.complete, false);
  assert.equal(follow.tokens.pointers, follow.neighbors.reduce((n, p) => n + p.tokens, 0));
  // Edges written in the {agent=skip} section are not followed (S2), even when reading the whole document.
  const whole = readSmd(A, { ...base, mode: 'full', follow: 'link', readDocument: reader }).follow!;
  assert.ok(whole.neighbors.every((n) => n.edge.line < 33));
  // Following only kinds that the section has none of says so.
  assert.match(readSmd(A, { ...base, sections: ['Requirements'], follow: 'lifecycle' }).text, /^Edges followed from this content \(supersedes,between; out; depth 1\): none\.$/m);
});

test('G3: direction in finds what points at the content, in the document and in the documents given; depth goes to 3', () => {
  const inward = readSmd(A, { ...base, sections: ['Requirements'], follow: 'link', direction: 'in', documents: [{ path: 'docs/b.smd', text: B }] }).follow!;
  assert.deepEqual(inward.neighbors.map((n) => `${n.direction}:${n.node?.file}:${n.node?.title}`), ['in:docs/b.smd:B intro']);
  // Without the other documents, only the document's own edges point in.
  assert.deepEqual(readSmd(A, { ...base, sections: ['Requirements'], follow: 'link', direction: 'in' }).follow!.neighbors, []);
  const deep = readSmd(A, { ...base, sections: ['Requirements'], follow: 'link', depth: 2, readDocument: reader }).follow!;
  assert.deepEqual(deep.neighbors.map((n) => `${n.depth}:${n.node?.title}`), ['1:Design', '1:B intro', '2:undefined'], 'the denied link in Design, one hop on');
  assert.equal(readSmd(A, { ...base, sections: ['Requirements'], follow: 'link', depth: 9 }).follow!.depth, 3);
  assert.throws(() => readSmd(A, { ...base, follow: 'supercedes' }), (e: Error) => e instanceof EdgeTypeError && /Did you mean "supersedes"\?/.test(e.message));
});

test('G4, G5: mandatory edges come in full once, and what cannot be satisfied makes the result incomplete', () => {
  // Includes shown in place by the view are not repeated, and what the view reports as unsatisfied (D3's missing
  // dependency, the include it could not read) is not reported again.
  const shown = readSmd(A, { ...base, sections: ['Design'], follow: 'mandatory', readDocument: reader });
  assert.equal(shown.text.match(/A term means one thing\./g)?.length, 1);
  assert.deepEqual(shown.follow!.dependencies, []);
  assert.deepEqual(shown.follow!.unsatisfied, []);
  assert.doesNotMatch(shown.text, /Unsatisfied dependency/);
  assert.equal(shown.text.match(/NOPE/g)?.length, 2, 'its attribute and the view\'s report');
  // What only the edges find is reported, and makes the result incomplete.
  const plain = readSmd(D, { file: 'docs/d.smd', today: TODAY, readFile, follow: '*', readDocument: reader });
  const f = plain.follow!;
  assert.equal(plain.shown, 'full');
  assert.deepEqual(f.dependencies, [], 'c.smd is shown in place');
  // The view lists the include it could not read itself (decided 2026-11-12), so follow does not repeat it, and the
  // result is still incomplete.
  assert.deepEqual(f.unsatisfied, []);
  assert.deepEqual(plain.mandatory?.unsatisfied.map((u) => `${u.kind}:${u.target}`), ['include:../secret.smd']);
  assert.equal(f.complete, false);
  assert.match(plain.text, /^- included file \.\.\/secret\.smd \[L7\]: not read \(cannot read the file\)$/m);
  assert.match(plain.text, /^\[incomplete: resolution failed for 1 include\]$/m);
  assert.doesNotMatch(plain.text, /^Unsatisfied dependency:/m);
  assert.match(plain.text, /^ {2}-> link {8}document {2}Plan B {2}docs\/b\.smd {2}≈\d+ tokens$/m);
  // A host that shows no includes in place gets the included file in full from the edges.
  const bare = readSmd(A, { file: 'docs/a.smd', today: TODAY, sections: ['Design'], follow: 'include', readDocument: reader });
  assert.deepEqual(bare.follow!.dependencies.map((d) => `${d.edge.type}:${d.node.file}`), ['include:docs/c.smd']);
  assert.match(bare.text, /^Dependencies along these edges \(included in full\):\ndocs\/c\.smd {2}\(include from L29\)\nA term means one thing\.$/m);
  assert.equal(bare.follow!.tokens.dependencies, bare.follow!.dependencies[0].tokens);
  // A constraint the view already carries ("Constraints that apply here") is not repeated.
  const req = readSmd(A, { ...base, sections: ['Requirements'], follow: 'applies-to' });
  assert.equal(req.text.match(/Keep requirements testable/g)?.length, 1);
  assert.deepEqual(req.follow!.dependencies, []);
});

test('R19, G5: a section read and its followed edges agree on a dependency in another file, and complete says what the view says', () => {
  const spec = ['---', 'smd: 2', 'title: Spec', '---', '## Reqs', '', ':::requirement{#R1 depends-on=base.smd#B1} One', 'Body.', ':::', '',
    '## Other', '', ':::requirement{#R2 depends-on=MISSING} Two', ':::', ''].join('\n');
  const open = ['---', 'smd: 2', 'title: Base', '---', '## Shared', '', ':::constraint{#B1} Visible base', 'Show this.', ':::', ''].join('\n');
  const skip = open.replace('## Shared', '## Hidden {agent=skip}').replace('Visible base', 'Secret base').replace('Show this.', 'Do not show this.');
  const files = (base: string) => ({ file: 'docs/spec.smd', today: TODAY, readDocument: (p: string): DocumentRead => (p === 'docs/base.smd' ? { text: base } : { status: 'missing' }) });

  // An allowed file: the view carries B1 and says nothing is missing; following adds nothing more.
  const allowed = readSmd(spec, { ...files(open), sections: ['Reqs'], follow: '*' });
  assert.equal(allowed.text.match(/Visible base/g)?.length, 1);
  assert.doesNotMatch(allowed.text, /outside what the host allows|Not satisfied|incomplete/);
  assert.equal(allowed.mandatory?.complete, true);
  assert.equal(allowed.follow!.complete, true);
  // Without follow the view reads it through readFile, inside what the host allows.
  const viaReadFile = readSmd(spec, { file: 'docs/spec.smd', today: TODAY, sections: ['Reqs'], readFile: (p) => (p === 'base.smd' ? open : undefined) });
  assert.match(viaReadFile.text, /Visible base/);
  assert.equal(viaReadFile.mandatory?.complete, true);
  const denied = readSmd(spec, { file: 'docs/spec.smd', today: TODAY, sections: ['Reqs'] });
  assert.match(denied.text, /R1 depends on base\.smd#B1 \[L7\]: outside what the host allows/);

  // A block under {agent=skip} in the other file stays out of the view and of what following adds.
  const hidden = readSmd(spec, { ...files(skip), sections: ['Reqs'], follow: '*' });
  assert.doesNotMatch(hidden.text, /Secret base|Do not show this/);
  assert.match(hidden.text, /R1 depends on base\.smd#B1 \[L7\]: the block is for people only/);
  assert.deepEqual(hidden.follow!.dependencies, []);
  assert.equal(hidden.follow!.complete, false);

  // A dependency the view reports missing makes the follow result incomplete too, though it is reported once.
  const missing = readSmd(spec, { ...files(open), sections: ['Other'], follow: '*' });
  assert.match(missing.text, /R2 depends on MISSING \[L13\]: no block has this id/);
  assert.deepEqual(missing.follow!.unsatisfied, []);
  assert.equal(missing.follow!.complete, false);
});

test('R19: the view reads a dependency from the documents given and through readDocument, with or without follow', () => {
  const spec = ['---', 'smd: 2', 'title: Spec', '---', '## Reqs', '', ':::requirement{#R1 depends-on=base.smd#B1} One', 'Body.', ':::', ''].join('\n');
  const open = ['---', 'smd: 2', 'title: Base', '---', '## Shared', '', ':::constraint{#B1} Visible base', 'Show this.', ':::', ''].join('\n');
  const documents = [{ path: 'docs/base.smd', text: open }];
  const carried = (r: ReturnType<typeof readSmd>, what: string) => {
    assert.equal(r.text.match(/Visible base/g)?.length, 1, `${what}: the view carries B1 once`);
    assert.doesNotMatch(r.text, /outside what the host allows/, what);
    assert.equal(r.mandatory?.complete, true, what);
  };

  // Documents given: the view and following agree, and following repeats nothing.
  const followed = readSmd(spec, { file: 'docs/spec.smd', today: TODAY, sections: ['Reqs'], follow: '*', documents });
  carried(followed, 'documents with follow');
  assert.equal(followed.follow!.complete, true);
  assert.deepEqual(followed.follow!.dependencies, []);
  carried(readSmd(spec, { file: 'docs/spec.smd', today: TODAY, sections: ['Reqs'], documents }), 'documents without follow');
  // A readDocument callback counts without follow too, by the dependency's normalized path.
  const asked: string[] = [];
  const readDoc = (p: string): DocumentRead => { asked.push(p); return p === 'docs/base.smd' ? { text: open } : { status: 'missing' }; };
  carried(readSmd(spec, { file: 'docs/spec.smd', today: TODAY, sections: ['Reqs'], readDocument: readDoc }), 'readDocument without follow');
  assert.deepEqual([...new Set(asked)], ['docs/base.smd']);
  // A document given comes first, and what neither has falls back to readFile as before.
  carried(readSmd(spec, { file: 'docs/spec.smd', today: TODAY, sections: ['Reqs'], documents, readDocument: () => ({ status: 'denied' }) }), 'documents before readDocument');
  const other = [{ path: 'docs/unrelated.smd', text: '# Other\n' }];
  carried(readSmd(spec, { file: 'docs/spec.smd', today: TODAY, sections: ['Reqs'], documents: other, readFile: (p) => (p === 'base.smd' ? open : undefined) }), 'readFile fallback');
});

test('S4: the followed text counts toward the read budget, and an outline follows nothing', () => {
  const full = readSmd(A, { ...base, mode: 'full', follow: '*', readDocument: reader });
  const view = readSmd(A, { ...base, mode: 'full' });
  assert.ok(full.follow!.tokens.shown > 0);
  assert.equal(full.fullTokens, view.fullTokens, 'fullTokens stays the view\'s size');
  // A budget the view fits but the view and its edges don't: the outline, which says why.
  const between = view.fullTokens + 1;
  assert.equal(readSmd(A, { ...base, maxTokens: between }).shown, 'full');
  const routed = readSmd(A, { ...base, maxTokens: between, follow: '*', readDocument: reader });
  assert.equal(routed.shown, 'outline');
  assert.equal(routed.follow, undefined);
  assert.match(routed.text, /The agent view and what its followed edges add \(≈\d+ tokens\) are over the \d+-token budget/);
  assert.equal(readSmd(A, { ...base, maxTokens: view.fullTokens + full.follow!.tokens.shown, follow: '*', readDocument: reader }).shown, 'full');
});

test('provenance: the manifest records what follow added, maps its lines, and lists what is unsatisfied', () => {
  const options: ReadOptions = { file: 'docs/d.smd', today: TODAY, readFile, sections: ['Part'], provenance: true };
  const result = readSmd(D, { ...options, follow: '*', direction: 'both', readDocument: reader });
  const plain = readSmd(D, options);
  const p = result.provenance!;
  assert.equal(plain.provenance!.follow, undefined);
  assert.equal(p.follow!.direction, 'both');
  // The view reports the unread include itself (decided 2026-11-12), so the followed edges add nothing to it.
  assert.deepEqual(p.follow!.unsatisfied, []);
  assert.equal(p.follow!.complete, false);
  assert.ok(p.omissions.some((o) => o.kind === 'dependency' && /an include is not read/.test(o.reason)));
  assert.equal(p.size.tokens, plain.provenance!.size.tokens + result.follow!.tokens.shown);
  const lines = result.text.replace(/\n$/, '').split('\n').length;
  assert.deepEqual(p.sourceMap.at(-1)!.output[1], lines);
  assert.equal(p.sourceMap.at(-1)!.kind, 'synthesized');
  // A dependency's text maps to its source.
  const bare = readSmd(A, { file: 'docs/a.smd', today: TODAY, sections: ['Design'], follow: 'include', readDocument: reader, provenance: true }).provenance!;
  assert.ok(bare.sourceMap.some((s) => s.kind === 'source' && s.file === 'docs/c.smd'));
  assert.deepEqual(bare.follow!.files.map((f) => `${f.path}:${f.status}`), ['docs/c.smd:read']);
});

test('CLI: smd read checks --follow, --direction and --depth as smd query does', () => {
  assert.deepEqual(followOptions({}), { direction: 'out', depth: 1 });
  assert.deepEqual(followOptions({ follow: '*', direction: 'both', depth: '3' }), { direction: 'both', depth: 3 });
  const errors = [
    followOptions({ follow: 'nope' }), followOptions({ depth: '2' }), followOptions({ follow: 'link', direction: 'up' }), followOptions({ follow: 'link', depth: '4' }),
  ].map((r) => ('error' in r ? r.error : ''));
  assert.match(errors[0], /^Unknown edge type "nope"\./);
  assert.equal(errors[1], '--direction and --depth go with --follow, e.g. --follow "*" --direction in.');
  assert.equal(errors[2], '--direction takes out, in or both (got "up").');
  assert.equal(errors[3], '--depth takes 1, 2 or 3 (got "4").');
  // smd query gives the same messages.
  const q = (more: object) => runQuery('decision', ['.'], { json: false, titles: false, brief: false, lineRefs: true, ...more });
  assert.deepEqual([q({ follow: 'nope' }), q({ depth: '2' }), q({ follow: 'link', direction: 'up' }), q({ follow: 'link', depth: '4' })].map((o) => [o.code, o.stderr.trimEnd()]), errors.map((e) => [2, e]));
});
