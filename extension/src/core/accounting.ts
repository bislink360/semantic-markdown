import { alertLines, parseSmd } from './parse';
import type { Omission, OmissionKind } from './provenance';
import { tagBlocks } from './semanticTags';

/**
 * One outcome per source block per view (view laws L6, target form; improvement roadmap t-67, paper addition A3).
 *
 * Units. The blocks are those of the document itself, after its front matter (the view's header stands for that):
 * - a heading line;
 * - a `:::` container, at any depth, with its own lines (its opening and closing fences and what it holds, without
 *   the containers nested in it, which are blocks of their own);
 * - a code block, a display math block or a GitHub alert outside any container;
 * - a run of other non-blank lines outside any container, up to a blank line (a paragraph, a list, a table, a comment).
 * Included files are not split into blocks: their text hangs from the `:::include` block that brings it in.
 *
 * Outcomes. Each block has exactly one, decided in this order:
 * - `unavailable`: an include the reader could not read;
 * - `condensed`: the block itself is condensed to a pointer or shortened (a details or deprecated block, a long fence
 *   or diagram, completed tasks);
 * - `shown`: its lines are in the view's body, in place;
 * - `carried`: its lines are in the view although it sits in a part the view leaves out or condenses (a section not
 *   selected, a condensed details block), in the head or in the body;
 * - `omitted`: left out, with the omission's kind and reason;
 * - `unaccounted`: none of these, which is a defect the fuzz test and the conformance suite look for.
 * Where a block appears (`placement`) is recorded apart from its outcome, so a danger carried out of a condensed
 * details block is `carried` with placement `body`.
 */

export type BlockOutcome = 'shown' | 'carried' | 'condensed' | 'omitted' | 'unavailable' | 'unaccounted';

export interface BlockAccount {
  /** `heading`, a container's name, `code`, `math`, `alert` or `text`. */
  kind: string;
  id?: string;
  /** A heading's text. */
  title?: string;
  /** One-based first and last line of the block, its nested blocks included. */
  lines: [number, number];
  outcome: BlockOutcome;
  /** For `omitted` and `condensed`: the omission's kind and reason. */
  omission?: { kind: OmissionKind; reason: string };
  /** Where its lines appear: in the view's body, in its head (or the footnotes after it), or nowhere. */
  placement: 'body' | 'head' | 'none';
  /** One-based first and last output line where it appears. */
  output?: [number, number];
  /** The index of the container it sits in, in this list. */
  parent?: number;
}

/** A view line matched to a traced source line (see provenance.ts): zero-based lines, and the part of the view. */
export interface MatchedLine { kind: string; file?: string; line?: number; end?: number; root?: number; part?: 'head' | 'body' }

/** Kinds of omission that condense a block rather than leave it out. */
const CONDENSING: ReadonlySet<OmissionKind> = new Set(['details', 'deprecated', 'diagram', 'code', 'completed-tasks']);
/** Omissions that stand for a block or a range of the document (not a one-line marker of a problem elsewhere). */
const RANGE_KINDS: ReadonlySet<OmissionKind> = new Set([
  'skipped-section', 'not-selected', 'budget', 'human', 'details', 'diagram', 'code', 'completed-tasks', 'comment', 'include', 'embed', 'deprecated',
]);

interface Unit { kind: string; id?: string; title?: string; start: number; end: number; own: number[]; parent?: number }

/** The blocks of a document after its front matter, as the module comment defines them. */
export function documentUnits(text: string, bodyStart: number): Unit[] {
  const lines = text.split(/\r?\n/);
  const owner = new Array<number | undefined>(lines.length);
  const units: Unit[] = [];
  // Containers, outermost first, so a nested one takes its lines from its parent.
  const containers = tagBlocks(text).filter((b) => b.line >= bodyStart).sort((a, b) => a.line - b.line || b.endLine - a.endLine);
  const index = new Map<object, number>();
  for (const b of containers) {
    const parent = b.parent ? index.get(b.parent) : undefined;
    index.set(b, units.length);
    units.push({ kind: b.name, ...(b.id ? { id: b.id } : {}), start: b.line, end: b.endLine, own: [], ...(parent === undefined ? {} : { parent }) });
    for (let i = b.line; i <= b.endLine; i++) owner[i] = units.length - 1;
  }
  const parsed = parseSmd(text);
  const add = (kind: string, start: number, end: number, id?: string, title?: string) => {
    if (start < bodyStart || owner[start] !== undefined) return;
    units.push({ kind, ...(id ? { id } : {}), ...(title ? { title } : {}), start, end, own: [] });
    for (let i = start; i <= end; i++) if (owner[i] === undefined) owner[i] = units.length - 1;
  };
  for (const h of parsed.headings) add('heading', h.line, h.line, h.slug, h.text);
  for (const [a, b] of parsed.code) add('code', a, b - 1);
  for (const [a, b] of parsed.math) add('math', a, b - 1);
  for (const a of alertLines(text)) {
    let last = a.end - 1;
    while (last > a.start && !lines[last]?.trim()) last--;
    add('alert', a.start, last);
  }
  // Runs of other non-blank lines outside containers.
  for (let i = bodyStart; i < lines.length; i++) {
    if (owner[i] !== undefined || !lines[i].trim()) continue;
    let j = i;
    while (j + 1 < lines.length && owner[j + 1] === undefined && lines[j + 1].trim()) j++;
    add('text', i, j);
    i = j;
  }
  for (let i = bodyStart; i < lines.length; i++) if (owner[i] !== undefined && lines[i].trim()) units[owner[i]!].own.push(i);
  // Document order, with parents kept pointing at the right block.
  const order = units.map((u, i) => [u, i] as const).sort(([a], [b]) => a.start - b.start || b.end - a.end);
  const moved = new Map(order.map(([, old], now) => [old, now]));
  return order.map(([u]) => ({ ...u, ...(u.parent === undefined ? {} : { parent: moved.get(u.parent)! }) }));
}

/** The outcome of every block of `file` in one view, from the view's matched lines and its omissions. */
export function accountBlocks(input: {
  text: string; file: string; bodyStart: number; matched: ReadonlyArray<MatchedLine | null>; omissions: readonly Omission[];
}): BlockAccount[] {
  const units = documentUnits(input.text, input.bodyStart);
  const own = input.omissions.filter((o) => o.file === input.file && RANGE_KINDS.has(o.kind));
  const covering = (line: number) => own.filter((o) => line + 1 >= o.lines[0] && line + 1 <= o.lines[1])
    .sort((a, b) => (a.lines[1] - a.lines[0]) - (b.lines[1] - b.lines[0]))[0];
  const out: BlockAccount[] = [];
  for (const u of units) {
    const mine = new Set(u.own);
    const where: Array<{ k: number; part: 'head' | 'body' }> = [];
    input.matched.forEach((m, k) => {
      if (m?.kind !== 'source') return;
      const ownLine = m.file === input.file && u.own.some((l) => l >= m.line! && l <= m.end!);
      const hangs = m.file !== input.file && m.root !== undefined && mine.has(m.root);
      if (ownLine || hangs) where.push({ k, part: m.part ?? 'body' });
    });
    const body = where.filter((w) => w.part === 'body');
    const head = where.filter((w) => w.part === 'head');
    const parent = u.parent === undefined ? undefined : out[u.parent];
    const left = covering(u.start);
    // The block sits in a part the view leaves out or condenses: a range around it, or a parent that is not shown.
    const outside = (!!left && left.lines[0] - 1 !== u.start) || (!!parent && parent.outcome !== 'shown' && parent.outcome !== 'carried');
    const self = own.find((o) => CONDENSING.has(o.kind) && (o.lines[0] - 1 === u.start
      || (o.kind === 'completed-tasks' && u.own.some((l) => l + 1 >= o.lines[0] && l + 1 <= o.lines[1]))));
    const unread = u.kind === 'include' ? own.find((o) => o.kind === 'include' && o.lines[0] - 1 === u.start) : undefined;
    let outcome: BlockOutcome;
    let omission: BlockAccount['omission'];
    let placed = body.length ? body : head;
    if (unread) { outcome = 'unavailable'; omission = { kind: unread.kind, reason: unread.reason }; }
    else if (self) { outcome = 'condensed'; omission = { kind: self.kind, reason: self.reason }; }
    else if (body.length) outcome = outside ? 'carried' : 'shown';
    else if (head.length) outcome = 'carried';
    else if (left) { outcome = CONDENSING.has(left.kind) ? 'condensed' : 'omitted'; omission = { kind: left.kind, reason: left.reason }; placed = []; }
    else if (parent && ['omitted', 'condensed', 'unavailable'].includes(parent.outcome)) { outcome = parent.outcome; omission = parent.omission; }
    else outcome = 'unaccounted';
    out.push({
      kind: u.kind, ...(u.id ? { id: u.id } : {}), ...(u.title ? { title: u.title } : {}), lines: [u.start + 1, u.end + 1], outcome, ...(omission ? { omission } : {}),
      placement: placed.length ? placed[0].part : 'none',
      ...(placed.length ? { output: [placed[0].k + 1, placed.at(-1)!.k + 1] as [number, number] } : {}),
      ...(u.parent === undefined ? {} : { parent: u.parent }),
    });
  }
  // A block with only fences of its own (a layout container such as tabs or columns, an empty code block) has no text
  // a view prints: it is shown when what it holds is, or when it holds nothing, and otherwise takes the outcome of what
  // it holds. Innermost first, so nested layout settles first.
  // A block whose own text is all left out for a recorded reason (a column holding only a comment) takes that outcome.
  const lines = input.text.split(/\r?\n/);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].outcome !== 'unaccounted') continue;
    const text = units[i].own.filter((l) => !FENCE.test(lines[l]));
    const why = text.map((l) => covering(l));
    if (why.some((o) => !o)) continue;
    const children = out.filter((c) => c.parent === i);
    const seen = children.find((c) => c.outcome === 'shown' || c.outcome === 'carried' || c.outcome === 'condensed');
    const hidden = children.find((c) => c.outcome === 'omitted' || c.outcome === 'unavailable');
    const left = why[0];
    if (seen || (!children.length && !left)) Object.assign(out[i], { outcome: 'shown' as const });
    else if (left) Object.assign(out[i], { outcome: CONDENSING.has(left.kind) ? 'condensed' : 'omitted', omission: { kind: left.kind, reason: left.reason } });
    else if (hidden) Object.assign(out[i], { outcome: hidden.outcome, ...(hidden.omission ? { omission: hidden.omission } : {}) });
  }
  return out;
}

/** A fence line: a container's opening or closing colons, a code fence, or a display math delimiter. */
const FENCE = /^\s*(?::{3,}|`{3,}|~{3,}|\$\$)/;

/**
 * Sections against protected blocks (agent blocks, non-goals, dangers and CAUTION alerts, constraints), for the
 * omission panel: each protected block with the section it sits in and its outcome in this view (t-67).
 */
export function protectedMatrix(blocks: readonly BlockAccount[]): Array<{
  section: string | null; block: BlockAccount;
}> {
  const PROTECTED = new Set(['agent', 'non-goals', 'danger', 'constraint', 'alert']);
  const headings = blocks.filter((b) => b.kind === 'heading');
  return blocks.filter((b) => PROTECTED.has(b.kind)).map((block) => {
    const above = headings.filter((h) => h.lines[0] <= block.lines[0]).at(-1);
    return { section: above?.title ?? null, block };
  });
}
