import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BlockEditorSession, readEditorMessage, type BlockView, type DocumentPort, type HostMessage, type RenderMessage, type SessionMessage,
} from '../src/blockEditorSession';
import { renderBlocks, segmentSmd } from '../src/core/blocks';
import { blockRevision } from '../src/core/revision';
import type { TextEdit } from '../src/core/sourceEdit';
import { REVIEW_LABELS, reviewAnnouncement } from '../src/webview/blockEditorModel';

/**
 * The Block Editor's review buttons (feedback loop RFC, F4): Accept and Reject on open suggestions, Resolve on open
 * comments, Rebase instead of Accept when stale, made through the core review functions as one undoable edit and
 * attributed to the reviewer (AF09).
 */

class FakeDoc implements DocumentPort {
  version = 1;
  readonly eol: '\n' | '\r\n';
  edits = 0;

  constructor(public text: string) {
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
  }

  getText(): string {
    return this.text;
  }

  applyEdits(edits: readonly TextEdit[]): boolean {
    this.edits++;
    for (const e of [...edits].sort((a, b) => b.from - a.from)) this.text = this.text.slice(0, e.from) + e.insert + this.text.slice(e.to);
    this.version++;
    return true;
  }
}

function harness(text: string, reviewer: string | undefined = '@lee') {
  const doc = new FakeDoc(text);
  const sent: HostMessage[] = [];
  const session = new BlockEditorSession(doc, {
    render: (t) => renderBlocks(t, { today: '2026-11-07' }),
    segment: (t) => segmentSmd(t, { today: '2026-11-07' }),
    templates: [],
    post: (m) => sent.push(m),
    reviewer: () => reviewer,
    today: () => '2026-11-08',
  });
  return {
    doc,
    sent,
    render: () => session.render(),
    async send(message: SessionMessage) {
      const before = sent.length;
      await session.handle(message);
      return sent.slice(before).at(-1);
    },
  };
}

const all = (views: readonly BlockView[]): BlockView[] => views.flatMap((v) => [v, ...all(v.children ?? [])]);
const find = (r: RenderMessage, prefix: string) => all(r.blocks).find((b) => b.kind === 'block' && b.source.startsWith(prefix))!;

const base = '---\nsmd: 2\ntitle: T\n---\n\n:::requirement{#R1} Cache\nTen minutes.\n:::\n';
const rev = (blockRevision(base, 'R1') as { revision: string }).revision;
const DOC = `${base}\n:::suggestion{for=R1 author=@agent date=2026-11-07 rev=${rev}}\nFive minutes.\n:::\n\n:::comment{for=R1 author=@maya rev=${rev}}\nWhy?\n:::\n`;

test('render: review blocks carry their buttons', () => {
  const r = harness(DOC).render();
  assert.deepEqual(find(r, ':::suggestion').review, { type: 'suggestion', status: 'open', stale: false, actions: ['accept', 'reject'] });
  assert.deepEqual(find(r, ':::comment').review, { type: 'comment', status: 'open', stale: false, actions: ['resolve'] });
  assert.equal(find(r, ':::requirement').review, undefined);
  const stale = harness(DOC.replace('Ten minutes.', 'Twenty minutes.')).render();
  assert.deepEqual(find(stale, ':::suggestion').review?.actions, ['rebase', 'reject']);
  const closed = harness(DOC.replace('rev=' + rev + '}\nWhy', `rev=${rev} status=resolved by=@a on=2026-01-01}\nWhy`)).render();
  assert.deepEqual(find(closed, ':::comment').review?.actions, []);
});

test('AF09: Accept replaces the target body as one edit, attributed to the reviewer, and keeps every other line', async () => {
  const h = harness(DOC);
  const r = h.render();
  const ack = await h.send({ type: 'review', key: find(r, ':::suggestion').key, action: 'accept', editId: 'e1' });
  assert.equal(ack?.type, 'ack');
  assert.equal(h.doc.edits, 1, 'one undoable edit');
  assert.match(h.doc.text, /:::requirement\{#R1\} Cache\nFive minutes\.\n:::/);
  assert.match(h.doc.text, /status=accepted by=@lee on=2026-11-08\}/);
  assert.ok(h.doc.text.endsWith(`:::comment{for=R1 author=@maya rev=${rev}}\nWhy?\n:::\n`));
});

test('Resolve and Reject record the transition; Rebase records the current revision', async () => {
  let h = harness(DOC);
  await h.send({ type: 'review', key: find(h.render(), ':::comment').key, action: 'resolve', editId: 'e1' });
  assert.match(h.doc.text, /:::comment\{for=R1 author=@maya rev=[0-9a-f]+ status=resolved by=@lee on=2026-11-08\}/);
  h = harness(DOC);
  await h.send({ type: 'review', key: find(h.render(), ':::suggestion').key, action: 'reject', editId: 'e1' });
  assert.match(h.doc.text, /status=rejected by=@lee on=2026-11-08\}/);
  h = harness(DOC.replace('Ten minutes.', 'Twenty minutes.'));
  const refused = await h.send({ type: 'review', key: find(h.render(), ':::suggestion').key, action: 'accept', editId: 'e1' });
  assert.equal(refused?.type, 'notice');
  assert.match((refused as { text: string }).text, /stale/);
  await h.send({ type: 'review', key: find(h.render(), ':::suggestion').key, action: 'rebase', editId: 'e2' });
  assert.deepEqual(find(h.render(), ':::suggestion').review?.actions, ['accept', 'reject']);
});

test('without a reviewer nothing is written; a block changed meanwhile is a conflict', async () => {
  const h = harness(DOC, '');
  const notice = await h.send({ type: 'review', key: find(h.render(), ':::comment').key, action: 'resolve', editId: 'e1' });
  assert.equal(notice?.type, 'notice');
  assert.equal(h.doc.text, DOC);
  const g = harness(DOC);
  const key = find(g.render(), ':::comment').key;
  g.doc.text = g.doc.text.replace('Why?', 'Why not?');
  g.doc.version++;
  const conflict = await g.send({ type: 'review', key, action: 'resolve', editId: 'e1' });
  assert.equal(conflict?.type, 'conflict');
});

test('CRLF documents stay CRLF', async () => {
  const h = harness(DOC.replaceAll('\n', '\r\n'));
  await h.send({ type: 'review', key: find(h.render(), ':::suggestion').key, action: 'accept', editId: 'e1' });
  assert.ok(!/[^\r]\n/.test(h.doc.text));
});

test('readEditorMessage: review takes a key and one of the four actions', () => {
  assert.deepEqual(readEditorMessage({ type: 'review', key: 'abc#0', action: 'accept', editId: 'e1' }), { type: 'review', key: 'abc#0', action: 'accept', editId: 'e1' });
  assert.equal(readEditorMessage({ type: 'review', key: 'abc#0', action: 'delete' }), undefined);
  assert.equal(readEditorMessage({ type: 'review', key: 'not a key', action: 'accept' }), undefined);
});

test('page: review buttons on the block and in the toolbar, labels and announcements', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'blockEditor.ts'), 'utf8');
  assert.match(page, /post\(\{ type: 'review', key: view\.key, action, editId \}\)/, 'by block key, never lines');
  assert.match(page, /updateReview\(node, view, false\)/);
  assert.match(page, /updateReview\(el, child, true\)/);
  assert.match(page, /buttons\[action\]\.hidden = !view\?\.review\?\.actions\.includes\(action\)/, 'the toolbar shows the current block\'s');
  assert.equal(REVIEW_LABELS.accept.text, 'Accept');
  assert.match(reviewAnnouncement('accept'), /Ctrl\+Z/);
});
