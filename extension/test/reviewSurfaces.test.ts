import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentView, buildSite, formatSmd, querySmd, renderPage, renderSmd, smdToConfluence, smdToMarkdown, smdToNotion, smdToPandocHtml, validateSmd,
} from '../src/core';
import { exportTree } from '../src/core/exportTree';
import { smdToDocx } from '../src/core/docxWriter';
import { blockRevision } from '../src/core/revision';
import { withoutReviewBlocks } from '../src/core/review';

/**
 * Review comments and suggestions on every surface (feedback loop RFC, "Review comments and suggestions"): the
 * preview's review box, the agent view's compact form, exports that leave them out unless asked, query with `stale`,
 * the validator's review rules and `smd fmt`'s attribute order.
 */

const R1 = ':::requirement{#R1} Cache results\nThe cache keeps results for 10 minutes.\n:::';
const rev = (text: string, id = 'R1') => (blockRevision(text, id) as { revision: string }).revision;

function reviewed(status = 'review'): string {
  const base = `---\nsmd: 2\ntitle: T\nstatus: ${status}\n---\n\n## Cache {#cache}\n\n${R1}\n`;
  const r = rev(base);
  return `${base}
:::comment{for=R1 author=@maya date=2026-10-21 rev=${r}} Too long?
Pricing changes hourly.
:::

:::comment{for=R1 author=@lee date=2026-10-22 rev=000000000000}
Old remark.
:::

:::suggestion{for=R1 author=@agent date=2026-10-23 rev=${r}}
The cache keeps results for 5 minutes.
:::

:::suggestion{for=R1 author=@agent rev=${r} status=rejected by=@maya on=2026-10-24 reason="Too short"}
One minute.
:::

:::comment{for=R1 author=@kim status=resolved by=@kim on=2026-10-25}
Fixed.
:::
`;
}

const plain = `---\nsmd: 2\ntitle: T\n---\n\n## Cache\n\n${R1}\n\nText **bold**.\n`;

test('preview: an open item is a review box with author, date and kind; a stale one has a pill; a closed one is a one-line record', () => {
  const html = renderSmd(reviewed()).html;
  assert.match(html, /<aside class="smd-review smd-review-comment smd-review-open"[^>]*data-review="comment" data-review-status="open" data-review-for="R1" aria-label="Comment"><div class="smd-review-head"><span class="smd-review-label">Comment<\/span><span class="smd-review-kind">remark<\/span><span class="smd-review-facts"><span>for R1<\/span><span class="smd-dot">·<\/span><span>@maya<\/span><span class="smd-dot">·<\/span><span>2026-10-21<\/span><\/span><\/div><div class="smd-review-title">Too long\?<\/div>/);
  assert.match(html, /smd-review-stale"[^>]*data-review-stale="true"[^>]*>.*?<span class="smd-review-stale-pill" title="The block it is for changed since it was written">stale<\/span>/s);
  assert.match(html, /<details class="smd-review smd-review-suggestion smd-review-closed smd-review-rejected"[^>]*><summary class="smd-review-record"><span class="smd-review-label">Suggestion<\/span> <span class="smd-review-status">rejected by @maya on 2026-10-24<\/span><\/summary>/);
  assert.match(html, /<p data-line="13">Pricing changes hourly\.<\/p>/);
});

test('preview: labels follow the document language', () => {
  const html = renderSmd(reviewed().replace('status: review', 'lang: de')).html;
  assert.match(html, /<span class="smd-review-label">Kommentar<\/span><span class="smd-review-kind">Anmerkung<\/span>/);
  assert.match(html, /<span class="smd-review-label">Vorschlag<\/span> <span class="smd-review-status">abgelehnt von @maya am 2026-10-24<\/span>/);
});

test('agent view: open items in compact form, stale ones with the current revision, closed ones counted on one line', () => {
  const text = reviewed();
  const view = agentView(text, { file: 'doc.smd' }).text;
  assert.match(view, /<comment for="R1" author="@maya" kind="remark"> Too long\?\nPricing changes hourly\.\n<\/comment>/);
  assert.match(view, new RegExp(`<comment for="R1" author="@lee" kind="remark" stale="true" current-rev="${rev(text)}">\\nOld remark\\.\\n</comment>`));
  assert.match(view, /<suggestion for="R1" author="@agent">\nThe cache keeps results for 5 minutes\.\n<\/suggestion>/);
  assert.doesNotMatch(view, /One minute|Fixed\./);
  assert.ok(view.trimEnd().endsWith('[2 closed review items (resolved, accepted, rejected or withdrawn) left out: smd query "comment[status=resolved], suggestion[status!=open]" doc.smd lists them]'), view);
});

test('agent view: an answer is shown whatever its status, and is not counted as closed', () => {
  const text = `---\nsmd: 2\n---\n\n:::question{#Q1 status=answered} TTL?\nWhich?\n:::\n\n:::comment{for=Q1 author=@maya kind=answer status=resolved by=@a on=2026-01-01}\nFive.\n:::\n`;
  const view = agentView(text).text;
  assert.match(view, /<comment for="Q1" author="@maya" kind="answer" status="resolved" by="@a" on="2026-01-01">\nFive\.\n<\/comment>/);
  assert.doesNotMatch(view, /closed review/);
});

test('documents without review blocks: render, agent view, exports and validation are as before', () => {
  const html = renderSmd(plain).html;
  assert.doesNotMatch(html, /smd-review/);
  assert.equal(renderPage(plain), renderPage(plain, { comments: true }));
  assert.equal(smdToMarkdown(plain), smdToMarkdown(plain, { comments: true }));
  assert.doesNotMatch(agentView(plain).text, /review/);
  assert.deepEqual(validateSmd(plain).filter((d) => d.code.startsWith('review/')), []);
});

test('exports leave review blocks out by default and keep them with comments', () => {
  const text = reviewed();
  const has = (s: string) => /Pricing changes hourly/.test(s);
  assert.ok(!has(renderPage(text)) && has(renderPage(text, { comments: true })));
  assert.ok(!has(smdToMarkdown(text)) && has(smdToMarkdown(text, { comments: true })));
  assert.ok(!has(smdToPandocHtml(text)) && has(smdToPandocHtml(text, { comments: true })));
  assert.ok(!has(smdToConfluence(text)) && has(smdToConfluence(text, { comments: true })));
  assert.ok(!has(JSON.stringify(smdToNotion(text))) && has(JSON.stringify(smdToNotion(text, { comments: true }))));
  assert.ok(!has(JSON.stringify(exportTree(text))));
  const docx = (comments: boolean) => new TextDecoder().decode(smdToDocx(text, { comments, deflate: undefined }).data);
  assert.ok(!has(docx(false)) && has(docx(true)));
  const site = (comments?: boolean) => buildSite([{ path: 'index.smd', text }], { comments, today: '2026-11-07' }).files.find((f) => f.path === 'index.html')!.content;
  assert.ok(!has(site()) && has(site(true)));
  // The rest of the document is still there, and every review line is gone from to-md.
  const md = smdToMarkdown(text);
  assert.match(md, /The cache keeps results for 10 minutes\./);
  assert.doesNotMatch(md, /comment|suggestion|Too long/);
  assert.match(smdToMarkdown(text, { comments: true }), /> \*\*Comment \(for R1 · @maya · 2026-10-21\): Too long\?\*\*\n>\n> Pricing changes hourly\./);
});

test('a figure inside a hidden comment takes no number', () => {
  const text = `---\nsmd: 2\n---\n\n:::comment{for=f2}\n:::figure{#f1} One\nx\n:::\n:::\n\n:::figure{#f2} Two\ny\n:::\n`;
  assert.match(renderPage(text), /Figure 1/);
  assert.doesNotMatch(renderPage(text), /Figure 2/);
});

test('query: comment and suggestion with attributes, defaults and stale', () => {
  const text = reviewed();
  const open = querySmd(text, 'comment[status=open]');
  assert.deepEqual(open.map((m) => [m.attrs.author, m.attrs.kind, m.attrs.stale]), [['@maya', 'remark', 'false'], ['@lee', 'remark', 'true']]);
  assert.deepEqual(querySmd(text, 'comment[stale=true]').map((m) => m.attrs.author), ['@lee']);
  const closed = querySmd(text, 'comment[status=resolved], suggestion[status!=open]');
  assert.equal(closed.length, 2);
  // A query shows the closed blocks it matches, though the agent view leaves them out.
  assert.match(closed[0].text, /<suggestion for="R1" author="@agent" status="rejected" by="@maya" on="2026-10-24">\nOne minute\.\n<\/suggestion>/);
  assert.equal(querySmd(text, 'suggestion[for=R1][status=open]').length, 1);
});

test('validate: review/for, review/stale, review/rev, review/open, review/transition', () => {
  const text = reviewed() + '\n:::comment{author=@x}\nNo target.\n:::\n\n:::suggestion{for=R1 status=accepted}\nX.\n:::\n';
  const found = validateSmd(text).filter((d) => d.code.startsWith('review/')).map((d) => `${d.line + 1}:${d.code}:${d.severity}`);
  const lines = text.split('\n');
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
  assert.deepEqual(found, [
    `${at('@maya date=2026-10-21')}:review/open:hint`,
    `${at('@lee')}:review/stale:warning`,
    `${at('@lee')}:review/open:hint`,
    `${at('date=2026-10-23')}:review/open:hint`,
    `${at('{author=@x}')}:review/for:warning`,
    `${at('{author=@x}')}:review/open:hint`,
    `${at('for=R1 status=accepted')}:review/transition:warning`,
  ]);
  const noRev = `---\nsmd: 2\n---\n\n${R1}\n\n:::comment{for=R1}\nx\n:::\n`;
  assert.deepEqual(validateSmd(noRev).filter((d) => d.code === 'review/rev').map((d) => d.severity), ['hint']);
});

test('validate: open review blocks are errors in an approved document, answers never are', () => {
  const text = reviewed('approved');
  assert.deepEqual(validateSmd(text).filter((d) => d.code === 'review/open').map((d) => d.severity), ['error', 'error', 'error']);
  const answered = `---\nsmd: 2\nstatus: approved\n---\n\n:::question{#Q1 status=answered} TTL?\n:::\n\n:::comment{for=Q1 kind=answer rev=${rev(`---\nsmd: 2\nstatus: approved\n---\n\n:::question{#Q1 status=answered} TTL?\n:::\n`, 'Q1')}}\nFive.\n:::\n`;
  assert.deepEqual(validateSmd(answered).filter((d) => d.code.startsWith('review/')), []);
});

test('validate: for= goes through ref/unknown and ref/ambiguous', () => {
  const unknown = `---\nsmd: 2\n---\n\n${R1}\n\n:::comment{for=R2 rev=000000000000}\nx\n:::\n`;
  assert.ok(validateSmd(unknown).some((d) => d.code === 'ref/unknown' && /R2/.test(d.message)));
  const twice = `---\nsmd: 2\n---\n\n${R1}\n\n:::decision{#R1} Again\n:::\n\n:::comment{for=R1 rev=000000000000}\nx\n:::\n`;
  assert.ok(validateSmd(twice).some((d) => d.code === 'ref/ambiguous' && d.line === 11));
});

test('fmt: both containers get their attributes in spec order, and @names stay bare', () => {
  const text = '---\nsmd: 2\n---\n\n:::comment{status=open rev=abc for=R1 kind=remark author=@maya on=2026-01-02 by=@lee date=2026-01-01}\nx\n:::\n\n'
    + ':::suggestion{reason="No" on=2026-01-02 by=@lee status=rejected rev=abc date=2026-01-01 author=@a for=R1}\ny\n:::\n';
  const out = formatSmd(text);
  assert.match(out, /:::comment\{for=R1 author=@maya date=2026-01-01 rev=abc kind=remark status=open by=@lee on=2026-01-02\}/);
  assert.match(out, /:::suggestion\{for=R1 author=@a date=2026-01-01 rev=abc status=rejected by=@lee on=2026-01-02 reason=No\}/);
  assert.equal(formatSmd(out), out);
  // :::quote keeps quoting its prose author.
  assert.match(formatSmd('---\nsmd: 2\n---\n\n:::quote{author=Ada}\nx\n:::\n'), /:::quote\{author="Ada"\}/);
});

test('withoutReviewBlocks: the source without review blocks, line endings kept; the site search index leaves them out', () => {
  const text = '---\nsmd: 2\n---\n\nBefore.\n:::comment{for=x}\nGone.\n:::\nAfter.\n\n:::suggestion{for=x}\nAlso gone.\n:::\n';
  assert.equal(withoutReviewBlocks(text), '---\nsmd: 2\n---\n\nBefore.\n\nAfter.\n\n');
  assert.equal(withoutReviewBlocks(text.replaceAll('\n', '\r\n')), '---\r\nsmd: 2\r\n---\r\n\r\nBefore.\r\n\r\nAfter.\r\n\r\n');
  assert.equal(withoutReviewBlocks('Last.\n\n:::comment{for=x}\nGone.\n:::'), 'Last.\n');
  assert.equal(withoutReviewBlocks(plain), plain);
  const index = (comments?: boolean) => buildSite([{ path: 'index.smd', text: reviewed() }], { comments, today: '2026-11-07' })
    .files.find((f) => f.path.endsWith('search-index.js'))!.content;
  assert.doesNotMatch(index(), /Pricing changes hourly/);
  assert.match(index(true), /Pricing changes hourly/);
});
