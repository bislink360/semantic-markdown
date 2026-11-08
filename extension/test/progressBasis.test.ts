import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, renderSmd, smdToMarkdown, validateSmd } from '../src/core';
import { exportTree, inlineText } from '../src/core/exportTree';
import { sectionTaskCounts } from '../src/core/progress';

const V2 = '---\nsmd: 2\n---\n';
const html = (text: string) => renderSmd(text).html;
const bars = (text: string) => [...html(text).matchAll(/<span class="smd-progress(?: [^"]*)?" role="progressbar".*?<span class="smd-progress-label">[^<]*<\/span><\/span>/g)].map((m) => m[0]);
const labels = (text: string) => [...html(text).matchAll(/<span class="smd-progress-label">([^<]*)<\/span>/g)].map((m) => m[1]);
const view = (text: string) => agentView(text, { lineRefs: false }).text;
const codes = (text: string) => validateSmd(text).map((d) => `${d.line}:${d.code}:${d.severity}`);

const plan = `${V2}# Plan

:progress{basis=tasks}

## Build

:progress{basis=tasks}

- [x] One
- [ ] Two

### Details

- [x] Three

## Ship

- [x] Four
`;

test('AF25: basis=tasks counts the checked tasks of its section, subsections included, and the whole document above the first heading', () => {
  assert.deepEqual(labels(`- [x] a\n\n:progress{basis=tasks}\n\n# A\n\n- [ ] b\n`), ['1 of 2 tasks checked']);
  assert.deepEqual(labels(plan), ['3 of 4 tasks checked', '2 of 3 tasks checked']);
  const [build] = bars(plan).slice(1);
  assert.match(build, /role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="67" aria-valuetext="2 of 3 tasks checked"/);
  assert.match(build, /<span class="smd-progress-bar" style="width:67%"><\/span>/);
  // Derived from the source: checking a task changes the count on the next render.
  assert.deepEqual(labels(plan.replace('- [ ] Two', '- [x] Two')), ['4 of 4 tasks checked', '3 of 3 tasks checked']);
  // A section with no tasks has no percentage to show.
  const none = bars(`${V2}# Empty\n\n:progress{basis=tasks}\n`)[0];
  assert.match(none, /aria-valuetext="0 of 0 tasks checked"/);
  assert.doesNotMatch(none, /aria-valuenow|smd-progress-bar/);
  // The source count agrees with rendering.
  const counts = sectionTaskCounts(plan);
  assert.deepEqual([counts(4), counts(8), counts(17)], [{ checked: 3, total: 4 }, { checked: 2, total: 3 }, { checked: 1, total: 1 }]);
});

test('AF25: value=unknown shows unknown progress, not a number; measured and estimate say how a value was found', () => {
  const [unknown] = bars(':progress{value=unknown}');
  assert.equal(unknown, '<span class="smd-progress smd-progress-unknown" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuetext="unknown"><span class="smd-progress-track"></span><span class="smd-progress-label">unknown</span></span>');
  assert.deepEqual(labels(':progress{value=40 basis=estimate} :progress{value=72.4 basis=measured}'), ['40% (estimated)', '72% (measured)']);
  assert.match(bars(':progress{value=40 basis=estimate}')[0], /aria-valuenow="40" aria-valuetext="40% \(estimated\)"/);
});

test('AF25: the labels are localized', () => {
  const de = `---\nsmd: 2\nlang: de\n---\n# Plan\n\n:progress{basis=tasks} :progress{value=unknown} :progress{value=40 basis=estimate}\n\n- [x] a\n- [ ] b\n`;
  assert.deepEqual(labels(de), ['1 von 2 Aufgaben abgehakt', 'unbekannt', '40% (geschätzt)']);
  assert.match(html(de), /aria-label="Fortschritt"[^>]*aria-valuetext="1 von 2 Aufgaben abgehakt"/);
});

test('AF25: the agent view, smd to-md and exports state the basis and the counts', () => {
  const doc = `${V2}# Plan\n\n:progress{basis=tasks} :progress{value=unknown} :progress{value=40 basis=estimate} :progress{value=55 basis=measured label="Coverage"}\n\n- [x] a\n- [x] b\n- [ ] c\n- [ ] d\n- [x] e\n`;
  assert.match(view(doc), /^\[progress 60%: 3 of 5 tasks checked\] \[progress unknown\] \[progress 40% \(estimated\)\] Coverage \[progress 55% \(measured\)\]$/m);
  assert.match(smdToMarkdown(doc), /^▰▰▰▰▰▰▱▱▱▱ 3 of 5 tasks checked progress unknown ▰▰▰▰▱▱▱▱▱▱ 40% \(estimated\) ▰▰▰▰▰▰▱▱▱▱ Coverage: 55% \(measured\)$/m);
  const paragraph = exportTree(doc).blocks.find((b) => b.kind === 'paragraph' && inlineText(b.content).includes('tasks'));
  assert.ok(paragraph && paragraph.kind === 'paragraph');
  assert.equal(inlineText(paragraph.content), '3 of 5 tasks checked unknown 40% (estimated) 55% (measured)');
  // A brief view folds checked tasks, and the bar still counts them.
  assert.match(agentView(doc, { brief: true }).text, /\[progress 60%: 3 of 5 tasks checked\]/);
});

test('AF25: a bar without a basis renders, exports and reads in the agent view exactly as before', () => {
  const doc = 'Done: :progress{value=60} :progress{value=30 label="Phase 1" color=green}\n';
  assert.equal(html(doc), '<article class="smd-doc"><p data-line="0">Done: <span class="smd-progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="60"><span class="smd-progress-track"><span class="smd-progress-bar" style="width:60%"></span></span><span class="smd-progress-label">60%</span></span> <span class="smd-progress" role="progressbar" aria-label="Phase 1" aria-valuemin="0" aria-valuemax="100" aria-valuenow="30"><span class="smd-progress-track"><span class="smd-progress-bar" style="width:30%;background:var(--smd-green)"></span></span><span class="smd-progress-label">Phase 1</span></span></p>\n</article>');
  assert.equal(view(doc), 'Done: 60% Phase 1\n');
  assert.equal(smdToMarkdown(doc), 'Done: ▰▰▰▰▰▰▱▱▱▱ 60% ▰▰▰▱▱▱▱▱▱▱ Phase 1\n');
});

test('AF25: progress/basis hints at a written value without a basis, and progress/basis-value warns that basis=tasks ignores a value', () => {
  assert.deepEqual(codes(`${V2}:progress{value=60}\n`), ['3:progress/basis:hint']);
  assert.deepEqual(codes(`${V2}:progress{value=60 basis=estimate} :progress{value=unknown} :progress{basis=tasks}\n`), []);
  assert.deepEqual(codes(`${V2}:progress{value=60 basis=tasks}\n`), ['3:progress/basis-value:warning']);
  // In spec v1 too, so a document validates the same in both versions.
  assert.deepEqual(codes(':progress{value=60} :progress{value=unknown}\n'), ['0:progress/basis:hint']);
  assert.deepEqual(codes(`${V2}:progress{value=lots}\n`), ['3:attrs/value:error']);
  assert.deepEqual(codes(`${V2}:progress{basis=guess}\n`).map((c) => c.split(':')[1]), ['attrs/value']);
  assert.match(validateSmd(`${V2}:progress{value=60}\n`)[0].message, /basis=measured or basis=estimate/);
});
