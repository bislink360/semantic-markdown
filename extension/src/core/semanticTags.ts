import {
  closeContainers, closerColons, CONTAINER_CLOSE, CONTAINER_OPEN, displayMath, openerColons, parseContainerInfo,
} from './containers';
import { parseFrontMatter } from './frontmatter';
import { splitIdRef } from './idTarget';
import { normalizePath, resolvePath } from './paths';
import { CONTAINERS, ID_ATTRIBUTES, idList } from './spec';
import { specVersion, type SpecVersion } from './specVersion';
import { scanTasks } from './taskLines';
import { own } from './util';

/**
 * The semantic tags (requirement, constraint, acceptance, assumption, evidence) and the lifecycle of questions and
 * decisions, read from a document's source. Rendering, the agent view, query and the validator ask these questions
 * here, so they agree on what a nested acceptance verifies, whether a question is answered and what supersedes what.
 */

/** The semantic tags of phases 1 to 3, in the order their labels and counts are listed. */
export const SEMANTIC_TAGS: readonly string[] = [
  'requirement', 'constraint', 'acceptance', 'assumption', 'evidence', 'non-goals', 'example', 'limitation', 'deprecated',
];

/** A container as written: its lines, id, title, attributes and the container it sits in. */
export interface TagBlock {
  name: string;
  /** Zero-based opening and closing lines (the last line of the document when it is never closed). */
  line: number;
  endLine: number;
  id?: string;
  /** The title as written. */
  title: string;
  /** The attributes as written, without the title. */
  values: Readonly<Record<string, string>>;
  parent?: TagBlock;
}

/** Requirement states that settle it: key content in budgets, and covered by acceptance criteria. */
export const SETTLED_REQUIREMENT: readonly string[] = ['accepted', 'implemented', 'verified'];
/** Requirement states that unblock a task that depends on it. */
const DONE_REQUIREMENT = new Set(['implemented', 'verified']);
/** The question attributes of the lifecycle: a question with none of them reads as before. */
const QUESTION_LIFECYCLE = ['status', 'owner', 'due', 'between', 'reason'];

const cache = new Map<string, TagBlock[]>();

/** Every container of a document in order, with the one it sits in. Code and display math hold none. */
export function tagBlocks(text: string): TagBlock[] {
  const known = cache.get(text);
  if (known) return known;
  const blocks = scan(text);
  if (cache.size > 32) cache.clear();
  cache.set(text, blocks);
  return blocks;
}

/** Whether the document may hold anything this module reads, without scanning it. */
export const mayHoldTags = (text: string): boolean =>
  /:{3,}\s*(?:requirement|constraint|acceptance|assumption|evidence|question|decision|comment|non-goals|limitation)\b|:depends\[/i.test(text);

function scan(text: string): TagBlock[] {
  const lines = text.split(/\r?\n/);
  const fm = parseFrontMatter(text);
  const spec: SpecVersion = specVersion(fm.data);
  const inMath = displayMath(lines, spec);
  const blocks: TagBlock[] = [];
  const open: Array<{ block: TagBlock; colons: number }> = [];
  let fence: { char: string; len: number } | null = null;
  for (let i = fm.bodyStartLine; i < lines.length; i++) {
    const line = lines[i];
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (mark && mark[1][0] === fence.char && mark[1].length >= fence.len && !line.slice(mark[0].length).trim()) fence = null;
      continue;
    }
    if (mark) { fence = { char: mark[1][0], len: mark[1].length }; continue; }
    if (inMath(i)) continue;
    if (CONTAINER_CLOSE.test(line)) {
      const done = closeContainers(open, closerColons(line), spec, (o) => o.colons);
      done.forEach((o, k) => { o.block.endLine = k === done.length - 1 ? i : i - 1; });
      continue;
    }
    const m = CONTAINER_OPEN.exec(line);
    const info = m ? parseContainerInfo(m[3] + m[4], spec) : null;
    if (!info) continue;
    const values: Record<string, string> = { ...info.attrs.values };
    delete values.title;
    const block: TagBlock = {
      name: info.name, line: i, endLine: lines.length - 1, title: info.title, values,
      ...(info.attrs.id ? { id: info.attrs.id } : {}), ...(open.length ? { parent: open.at(-1)!.block } : {}),
    };
    blocks.push(block);
    open.push({ block, colons: openerColons(line) });
  }
  return blocks;
}

/** An attribute's value: as written, else the spec's default for the tag (`status=proposed` on a requirement). */
export function tagValue(block: TagBlock, key: string): string | undefined {
  return block.values[key] ?? own(CONTAINERS[block.name]?.defaults ?? {}, key);
}

/** The ids an id attribute lists. */
export const listed = (block: TagBlock, key: string): string[] => (block.values[key] === undefined ? [] : idList(block.values[key]));

/** The nearest container around a block with that name. */
export function enclosing(block: TagBlock, name: string): TagBlock | undefined {
  for (let p = block.parent; p; p = p.parent) if (p.name === name) return p;
  return undefined;
}

/** What an acceptance block verifies: the requirement it sits in (when it has an id), then the ids it lists. */
export function verifiesOf(block: TagBlock): string[] {
  const parent = enclosing(block, 'requirement')?.id;
  return [...new Set([...(parent ? [parent] : []), ...listed(block, 'verifies')])];
}

/** The document's blocks by id; an id two containers give is left out. */
export function blocksById(blocks: readonly TagBlock[]): Map<string, TagBlock> {
  const byId = new Map<string, TagBlock>();
  const twice = new Set<string>();
  for (const b of blocks) {
    if (!b.id) continue;
    if (byId.has(b.id)) twice.add(b.id); else byId.set(b.id, b);
  }
  for (const id of twice) byId.delete(id);
  return byId;
}

const isAnswer = (b: TagBlock) => b.name === 'comment' && (b.values.kind ?? '').toLowerCase() === 'answer';

/** The ids of the questions an answer exists for: a `:::comment{kind=answer for=Q1}`, or one nested in the question. */
export function answeredQuestions(blocks: readonly TagBlock[]): Set<string> {
  const answered = new Set<string>();
  for (const b of blocks) {
    if (!isAnswer(b)) continue;
    for (const id of listed(b, 'for')) answered.add(id);
    const question = enclosing(b, 'question');
    if (question?.id) answered.add(question.id);
  }
  return answered;
}

/** Whether a question has an answer (see answeredQuestions); a question without an id can still hold one. */
export function hasAnswer(question: TagBlock, blocks: readonly TagBlock[], answered: ReadonlySet<string> = answeredQuestions(blocks)): boolean {
  if (question.id && answered.has(question.id)) return true;
  return blocks.some((b) => isAnswer(b) && enclosing(b, 'question') === question);
}

/**
 * A question's state (research contract, "Questions"): `answered` and `incorporated` hold only when an answer exists,
 * otherwise it is `open`. A question with an answer and no written status is `answered`.
 */
export function questionStatus(question: TagBlock, answer: boolean): string {
  const written = question.values.status?.trim().toLowerCase();
  if ((written === 'answered' || written === 'incorporated') && !answer) return 'open';
  return written || (answer ? 'answered' : 'open');
}

/** Whether a question uses the lifecycle (an attribute of it, or an answer), so the views show its state. */
export function isLifecycleQuestion(question: TagBlock, answer: boolean): boolean {
  return answer || QUESTION_LIFECYCLE.some((k) => question.values[k] !== undefined);
}

/**
 * The id of this document that a `supersedes` value names: a bare id, or `path#id` whose path resolves to `file`, the
 * document's own path (semantic tags R19, R53). Undefined for another document's id, or a path when `file` is unknown.
 */
export function ownSupersededId(written: string, file?: string): string | undefined {
  const { path, id } = splitIdRef(written);
  if (!path) return id;
  return file !== undefined && resolvePath(file, path) === normalizePath(file) ? id : undefined;
}

/**
 * The decisions that supersede each decision of the document, by id, in document order. With `file`, the document's
 * path, `supersedes=this.smd#D1` counts like `supersedes=D1`.
 */
export function supersededBy(blocks: readonly TagBlock[], file?: string): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const b of blocks) {
    if (b.name !== 'decision' || !b.id) continue;
    for (const written of listed(b, 'supersedes')) {
      const id = ownSupersededId(written, file);
      if (id !== undefined) by.set(id, [...(by.get(id) ?? []), b.id]);
    }
  }
  return by;
}

/** What the views need about a document's blocks, worked out once. */
export interface TagContext {
  blocks: readonly TagBlock[];
  byLine: ReadonlyMap<number, TagBlock>;
  answered: ReadonlySet<string>;
  supersededBy: ReadonlyMap<string, string[]>;
}

/** The context of a document's tags, or undefined when it has nothing this module reads. `file`: see supersededBy. */
export function tagContext(text: string, file?: string): TagContext | undefined {
  if (!mayHoldTags(text)) return undefined;
  const blocks = tagBlocks(text);
  return { blocks, byLine: new Map(blocks.map((b) => [b.line, b])), answered: answeredQuestions(blocks), supersededBy: supersededBy(blocks, file) };
}

/** The ids `:depends[…]` lists on a line (spec v2 only), in order. */
export function dependsIds(line: string, spec: SpecVersion): string[] {
  if (spec < 2) return [];
  const ids = [...line.replace(/`[^`]*`/g, '').matchAll(/(?:^|[\s([{>*_~"'-]):depends\[([^\]]*)\]/gi)].flatMap((m) => idList(m[1]));
  return [...new Set(ids)];
}

/**
 * Why a task that depends on `ids` is blocked: the ids whose block isn't done. A task is done when checked, a
 * requirement when `implemented` or `verified`, a question when it is no longer open. Other ids never block.
 */
export function blockers(ids: readonly string[], text: string): string[] {
  if (!ids.length) return [];
  const blocks = tagBlocks(text);
  const byId = blocksById(blocks);
  const answered = answeredQuestions(blocks);
  const tasks = new Map<string, boolean>();
  for (const t of scanTasks(text)) if (t.kind === 'task' && t.id) tasks.set(t.id, t.mark !== ' ');
  return ids.filter((id) => {
    if (tasks.has(id)) return !tasks.get(id);
    const block = byId.get(id);
    if (block?.name === 'requirement') return !DONE_REQUIREMENT.has((tagValue(block, 'status') ?? '').toLowerCase());
    if (block?.name === 'question') return questionStatus(block, hasAnswer(block, blocks, answered)) === 'open';
    return false;
  });
}

/**
 * The ids to offer while typing an id attribute (`verifies=`, `depends-on=`…): requirement ids for `verifies`, the
 * ids of containers and tasks otherwise. Empty for any other attribute.
 */
export function idChoices(text: string, container: string, key: string): string[] {
  if (!own(ID_ATTRIBUTES, key)?.includes(container)) return [];
  const only = key === 'verifies' ? 'requirement' : undefined;
  const ids = tagBlocks(text).filter((b) => b.id && (!only || b.name === only)).map((b) => b.id!);
  if (!only) ids.push(...scanTasks(text).flatMap((t) => (t.kind === 'task' && t.id ? [t.id] : [])));
  return [...new Set(ids)];
}
