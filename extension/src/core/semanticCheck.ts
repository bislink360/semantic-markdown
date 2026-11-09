import { findAttrsEnd } from './attrs';
import { CONTAINER_OPEN } from './containers';
import { idOwners, parseSmd } from './parse';
import { dueState } from './render';
import {
  answeredQuestions, blocksById, enclosing, hasAnswer, listed, mayHoldTags, questionStatus, SETTLED_REQUIREMENT, tagBlocks, tagValue,
  verifiesOf, type TagBlock,
} from './semanticTags';
import { quoteCite } from './quote';
import { idList } from './spec';
import type { SpecVersion } from './specVersion';
import { escapeRegExp } from './util';

/**
 * The validator's checks of the semantic tags and of the question and decision lifecycle (semantic tags RFC phase 1,
 * feedback loop RFC "Semantic tags phase 2"). Ids an id attribute names are checked by `ref/unknown` and
 * `ref/ambiguous` in validate.ts; these checks are about what the blocks say.
 */

type Severity = 'error' | 'warning' | 'info' | 'hint';
interface Fix { line: number; column: number; endColumn: number; replacement: string; title: string }
type Push = (line: number, column: number, endColumn: number, severity: Severity, code: string, message: string, fix?: Fix) => void;

export interface SemanticCheckOptions {
  today?: string;
  fileExists?: (relativePath: string) => boolean;
  spec: SpecVersion;
}

/** Document-scoped constraints cost every section read; above this many tokens together, `constraint/size` says so. */
const CONSTRAINT_BUDGET = 500;

export function checkSemanticTags(text: string, lines: readonly string[], push: Push, options: SemanticCheckOptions): void {
  if (!mayHoldTags(text)) return;
  const blocks = tagBlocks(text);
  if (!blocks.length) return;
  const at = new Place(lines, options.spec);
  checkIds(blocks, text, at, push);
  checkRequirements(blocks, at, push);
  checkAcceptance(blocks, text, at, push, options);
  checkConstraints(blocks, text, lines, at, push);
  checkAssumptions(blocks, at, push, options.today);
  checkEvidence(blocks, at, push);
  checkQuestions(blocks, at, push, options.today);
  checkSupersedes(blocks, at, push);
  checkNonGoals(blocks, lines, at, push);
}

const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;

/** A `:::non-goals` block is a list of exclusions: one with no list item gets `non-goals/list` (RFC phase 3). */
function checkNonGoals(blocks: readonly TagBlock[], lines: readonly string[], at: Place, push: Push): void {
  for (const b of blocks) {
    if (b.name !== 'non-goals' || lines.slice(b.line + 1, b.endLine).some((l) => LIST_ITEM.test(l))) continue;
    push(b.line, ...at.line(b), 'hint', 'non-goals/list', 'Write the non-goals as a list, one exclusion per item, so none reads as a goal.');
  }
}

/** Columns on a container's opening line: the whole line, an attribute, an id in an attribute, where an id goes. */
class Place {
  constructor(private readonly lines: readonly string[], private readonly spec: SpecVersion) {}

  line(b: TagBlock): [number, number] {
    const raw = this.lines[b.line] ?? '';
    return [raw.length - raw.trimStart().length, raw.length];
  }

  /** `key=value` as written, or the whole line. */
  attr(b: TagBlock, key: string): [number, number] {
    const raw = this.lines[b.line] ?? '';
    const m = new RegExp(`(?<![\\w-])${escapeRegExp(key)}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s}]*)`).exec(raw);
    return m ? [m.index, m.index + m[0].length] : this.line(b);
  }

  /** One id in the value of `key`, or the attribute. */
  id(b: TagBlock, key: string, id: string): [number, number] {
    const raw = this.lines[b.line] ?? '';
    const [start, end] = this.attr(b, key);
    const found = new RegExp(`(?<![\\w.-])${escapeRegExp(id)}(?![\\w.-])`).exec(raw.slice(start, end));
    return found ? [start + found.index, start + found.index + id.length] : [start, end];
  }

  /** A fix that adds `#id` to the block's attribute list, or gives it one. */
  addId(b: TagBlock, id: string): Fix {
    return { ...this.insert(b, `#${id}`, true), title: `Add the id ${id}` };
  }

  /** A fix that sets `key=value`: replaces it when written, else adds it to the attribute list. */
  setAttr(b: TagBlock, key: string, value: string): Fix {
    const title = `Set ${key}=${value}`;
    if (b.values[key] !== undefined) {
      const [column, endColumn] = this.attr(b, key);
      return { line: b.line, column, endColumn, replacement: `${key}=${value}`, title };
    }
    return { ...this.insert(b, `${key}=${value}`, false), title };
  }

  /** Text put in the attribute list (first, or last), or `{text}` after the name when there is none. */
  private insert(b: TagBlock, item: string, first: boolean): Omit<Fix, 'title'> {
    const raw = this.lines[b.line] ?? '';
    const m = CONTAINER_OPEN.exec(raw);
    const nameEnd = m ? raw.indexOf(m[3], m[1].length + m[2].length) + m[3].length : raw.length;
    if (raw[nameEnd] !== '{') return { line: b.line, column: nameEnd, endColumn: nameEnd, replacement: `{${item}}` };
    const close = findAttrsEnd(raw, nameEnd, this.spec);
    const empty = close === nameEnd + 1;
    if (first || close < 0) return { line: b.line, column: nameEnd + 1, endColumn: nameEnd + 1, replacement: empty ? item : `${item} ` };
    return { line: b.line, column: close, endColumn: close, replacement: empty ? item : ` ${item}` };
  }
}

const status = (b: TagBlock) => (tagValue(b, 'status') ?? '').toLowerCase();
const named = (blocks: readonly TagBlock[], name: string) => blocks.filter((b) => b.name === name);

/**
 * The next free id in the document's own pattern: the longest common prefix of the ids of that tag, then the next
 * number, so `R4` after `R3` and `REQ-12` after `REQ-11`; `fallback` and 1 when there are none.
 */
export function nextIds(existing: readonly string[], fallback: string, taken: ReadonlySet<string>, count: number): string[] {
  const numbered = existing.flatMap((id) => {
    const m = /^(.*?)(\d+)$/.exec(id);
    return m && m[1] ? [{ prefix: m[1], n: Number(m[2]) }] : [];
  });
  let prefix = numbered[0]?.prefix ?? '';
  for (const { prefix: p } of numbered) while (!p.startsWith(prefix)) prefix = prefix.slice(0, -1);
  if (!/[A-Za-z]/.test(prefix)) prefix = fallback;
  let n = Math.max(0, ...numbered.filter((x) => x.prefix === prefix).map((x) => x.n));
  const out: string[] = [];
  while (out.length < count) {
    n++;
    if (!taken.has(`${prefix}${n}`)) out.push(`${prefix}${n}`);
  }
  return out;
}

/** `requirement/id` and `acceptance/id`, with fixes that add the next free ids. */
function checkIds(blocks: readonly TagBlock[], text: string, at: Place, push: Push): void {
  const taken = new Set(idOwners(text).keys());
  const tags = [['requirement', 'R', 'A requirement', 'requirement/id'], ['acceptance', 'AC', 'An acceptance block', 'acceptance/id']] as const;
  for (const [name, fallback, label, code] of tags) {
    const all = named(blocks, name);
    const missing = all.filter((b) => !b.id);
    if (!missing.length) continue;
    const ids = nextIds(all.flatMap((b) => (b.id ? [b.id] : [])), fallback, taken, missing.length);
    missing.forEach((b, k) => {
      const [column, end] = at.line(b);
      push(b.line, column, end, 'warning', code,
        `${label} needs an {#id} so other blocks, tasks and reviews can name it — for example {#${ids[k]}}.`, at.addId(b, ids[k]));
    });
  }
}

/** `requirement/uncovered`: a settled requirement no acceptance block verifies. Coverage is not verification (AF26). */
function checkRequirements(blocks: readonly TagBlock[], at: Place, push: Push): void {
  const acceptance = named(blocks, 'acceptance');
  const verified = new Set(acceptance.flatMap(verifiesOf));
  for (const r of named(blocks, 'requirement')) {
    if (!SETTLED_REQUIREMENT.includes(status(r))) continue;
    if ((r.id && verified.has(r.id)) || acceptance.some((a) => enclosing(a, 'requirement') === r)) continue;
    const [column, end] = at.line(r);
    push(r.line, column, end, 'hint', 'requirement/uncovered',
      `${r.id ? `Requirement ${r.id}` : 'This requirement'} is ${status(r)} but no :::acceptance block verifies it. Add one that says how to check it.`);
  }
}

/** `acceptance/verifies`, `acceptance/verifies-type` and `link/missing-file` for `test=`. */
function checkAcceptance(blocks: readonly TagBlock[], text: string, at: Place, push: Push, options: SemanticCheckOptions): void {
  const acceptance = named(blocks, 'acceptance');
  if (!acceptance.length) return;
  const owners = idOwners(text);
  for (const a of acceptance) {
    if (!listed(a, 'verifies').length && !enclosing(a, 'requirement')) {
      const [column, end] = at.line(a);
      push(a.line, column, end, 'warning', 'acceptance/verifies',
        `This acceptance block verifies nothing: add verifies=<requirement id>, or put it inside the :::requirement it checks.`);
    }
    for (const id of listed(a, 'verifies')) {
      const found = owners.get(id);
      if (found?.length !== 1) continue; // ref/unknown and ref/ambiguous report these
      const target = blocks.find((b) => b.line === found[0].line && b.id === id);
      if (target?.name === 'requirement') continue;
      const [column, end] = at.id(a, 'verifies', id);
      const what = target ? `a :::${target.name}` : found[0].heading ? 'a heading' : 'not a requirement';
      push(a.line, column, end, 'warning', 'acceptance/verifies-type', `verifies names "${id}", which is ${what}. An acceptance block verifies requirements.`);
    }
    checkTestPath(a, at, push, options);
  }
}

function checkTestPath(a: TagBlock, at: Place, push: Push, options: SemanticCheckOptions): void {
  const test = a.values.test?.trim();
  if (!test || !options.fileExists || /^[a-z][a-z0-9+.-]*:/i.test(test) || test.startsWith('#')) return;
  const path = test.replace(/#.*$/, '');
  if (!path || options.fileExists(path)) return;
  const [column, end] = at.attr(a, 'test');
  push(a.line, column, end, 'warning', 'link/missing-file', `"${path}" does not exist (the test of ${a.id ? `acceptance ${a.id}` : 'this acceptance block'}).`);
}

/** `constraint/scope` above the first heading, and `constraint/size` when document-scoped constraints cost much. */
function checkConstraints(blocks: readonly TagBlock[], text: string, lines: readonly string[], at: Place, push: Push): void {
  const constraints = named(blocks, 'constraint');
  if (!constraints.length) return;
  const firstHeading = parseSmd(text).headings[0]?.line ?? -1;
  const wholeDocument: TagBlock[] = [];
  for (const c of constraints) {
    const scope = (tagValue(c, 'scope') ?? '').toLowerCase();
    const above = firstHeading < 0 || c.line < firstHeading;
    if (scope === 'section' && above && !c.values['applies-to']) {
      const [column, end] = c.values.scope ? at.attr(c, 'scope') : at.line(c);
      push(c.line, column, end, 'info', 'constraint/scope',
        'This constraint is above the first heading, so it applies to the whole document. Write scope=document to say so.', at.setAttr(c, 'scope', 'document'));
    }
    if (scope === 'document' || (scope === 'section' && above)) wholeDocument.push(c);
  }
  const tokens = wholeDocument.reduce((sum, c) => sum + Math.ceil(lines.slice(c.line, c.endLine + 1).join('\n').length / 4), 0);
  if (tokens > CONSTRAINT_BUDGET && wholeDocument[0]) {
    const [column, end] = at.line(wholeDocument[0]);
    push(wholeDocument[0].line, column, end, 'hint', 'constraint/size',
      `Document-wide constraints cost ≈${tokens} tokens together, and every section an agent reads pays for them (over ${CONSTRAINT_BUDGET}). Move the ones that bind one part to that section, or use applies-to.`);
  }
}

/** `assumption/overdue` and `assumption/invalid`. */
function checkAssumptions(blocks: readonly TagBlock[], at: Place, push: Push, today?: string): void {
  const assumptions = named(blocks, 'assumption');
  if (!assumptions.length) return;
  for (const a of assumptions) {
    const date = a.values['review-by'];
    if (date && status(a) === 'unvalidated' && dueState(date, today) === 'overdue') {
      const [column, end] = at.attr(a, 'review-by');
      push(a.line, column, end, 'info', 'assumption/overdue', `${a.id ? `Assumption ${a.id}` : 'This assumption'} was to be reviewed by ${date} and is still unvalidated.`);
    }
  }
  const byId = blocksById(blocks);
  for (const b of blocks) {
    const settled = (b.name === 'requirement' && SETTLED_REQUIREMENT.includes(status(b))) || (b.name === 'decision' && status(b) === 'accepted');
    if (!settled) continue;
    for (const id of listed(b, 'depends-on')) {
      const target = byId.get(id);
      if (target?.name !== 'assumption' || status(target) !== 'invalid') continue;
      const [column, end] = at.id(b, 'depends-on', id);
      push(b.line, column, end, 'warning', 'assumption/invalid', `This ${status(b)} ${b.name} depends on assumption ${id}, which is invalid. Revisit it.`);
    }
  }
}

/** A commit hash as `commit=` takes it: 7 to 40 hex characters. Whether the commit exists is not checked (R43). */
const COMMIT_HASH = /^[0-9a-f]{7,40}$/i;

/**
 * `evidence/unlinked` (R41), `evidence/rev`, `evidence/source` (R42) and `evidence/commit` (R43).
 * The stale check is evidence/stale. Ids that name no block are `ref/unknown`.
 */
function checkEvidence(blocks: readonly TagBlock[], at: Place, push: Push): void {
  for (const e of named(blocks, 'evidence')) {
    const [column, end] = at.line(e);
    if (listed(e, 'supports').length || listed(e, 'contradicts').length) {
      if (!e.values.rev) {
        push(e.line, column, end, 'hint', 'evidence/rev',
          'This evidence has no rev=, so a later change to what it supports can\'t be detected. Record the revision (smd rev <file> <id>).');
      }
    } else {
      // Nothing listed, including an empty supports="" or contradicts="", which names no block (R41).
      const empty = (['supports', 'contradicts'] as const).find((k) => e.values[k] !== undefined);
      push(e.line, ...(empty ? at.attr(e, empty) : [column, end] as const), 'info', 'evidence/unlinked', empty
        ? `This evidence's ${empty}= lists no id, so it neither supports nor contradicts anything and nothing counts it. Write the id it is about, e.g. ${empty}=R1.`
        : 'This evidence neither supports nor contradicts anything, so nothing counts it. Add supports=<id> or contradicts=<id>.');
    }
    const { source, commit } = e.values;
    if (source !== undefined && !quoteCite(source)) {
      push(e.line, ...at.attr(e, 'source'), 'warning', 'evidence/source',
        `source="${source}" is left out: it must be an http(s) URL or a relative path without spaces.`);
    }
    if (commit !== undefined && !COMMIT_HASH.test(commit.trim())) {
      push(e.line, ...at.attr(e, 'commit'), 'warning', 'evidence/commit',
        `commit="${commit}" is not a commit hash: write 7 to 40 hex characters, e.g. commit=3f2a9c1.`);
    }
  }
}

/** `question/unanswered`, `question/reason` and `question/overdue` (research contract, "Questions"). */
function checkQuestions(blocks: readonly TagBlock[], at: Place, push: Push, today?: string): void {
  const questions = named(blocks, 'question');
  if (!questions.length) return;
  const answered = answeredQuestions(blocks);
  for (const q of questions) {
    const written = q.values.status?.trim().toLowerCase();
    const answer = hasAnswer(q, blocks, answered);
    const state = questionStatus(q, answer);
    const who = q.id ? `Question ${q.id}` : 'This question';
    if ((written === 'answered' || written === 'incorporated') && !answer) {
      const [column, end] = at.attr(q, 'status');
      push(q.line, column, end, 'warning', 'question/unanswered',
        `${who} says status=${written}, but no answer exists, so it reads as open. Add a :::comment{kind=answer for=${q.id ?? '…'}} with the answer.`);
    }
    if (written === 'withdrawn' && !q.values.reason?.trim()) {
      const [column, end] = at.attr(q, 'status');
      push(q.line, column, end, 'warning', 'question/reason', `${who} is withdrawn without a reason: add reason="…".`);
    }
    const due = q.values.due;
    if (due && state === 'open' && dueState(due, today) === 'overdue') {
      const [column, end] = at.attr(q, 'due');
      push(q.line, column, end, 'info', 'question/overdue', `${who} was due ${due} and is still open.`);
    }
  }
}

/** `decision/supersedes`: a superseded decision whose status doesn't say so, with a fix that sets it. */
function checkSupersedes(blocks: readonly TagBlock[], at: Place, push: Push): void {
  const byId = blocksById(blocks);
  for (const d of named(blocks, 'decision')) {
    for (const id of idList(d.values.supersedes ?? '')) {
      const old = byId.get(id);
      if (old?.name !== 'decision' || status(old) === 'superseded') continue;
      const [column, end] = old.values.status ? at.attr(old, 'status') : at.line(old);
      push(old.line, column, end, 'warning', 'decision/supersedes',
        `Decision ${id} is superseded by ${d.id ?? `the decision on line ${d.line + 1}`}, but its status is ${status(old) || 'proposed'}. Set status=superseded.`,
        at.setAttr(old, 'status', 'superseded'));
    }
  }
}
