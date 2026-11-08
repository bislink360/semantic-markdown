/**
 * Constraints outside the selected sections (`smd agent --section … --constraints`), an experimental, opt-in policy.
 *
 * When an agent reads only some sections, a rule written elsewhere in the document can still apply. Policy
 * `constraints/1` decides what such a view adds after the document-wide agent instructions:
 *
 * - `:::danger` blocks (and `> [!CAUTION]` alerts): shown in full. The reader skill treats them as hard constraints.
 * - `:::warning` blocks, accepted `:::decision` blocks and `:::question` blocks: listed as pointers (type, title,
 *   line, section), not read. Many accepted decisions are unrelated or historical, so they are not appended.
 * - `:::include` blocks outside the sections are not opened. Each is listed, and the view is marked incomplete.
 * - Left out: sections marked {agent=skip}, `:::human` blocks, and constraints inside `:::agent` blocks or danger
 *   blocks (those are shown already). Proposed, rejected and superseded decisions are not constraints.
 *
 * Nothing is resolved or ranked: two blocks that disagree are both listed as written. The policy name is recorded in
 * the result so a reader knows which rules were applied. It changes no default.
 *
 * Policy `constraints/2`, for a document with `:::constraint` blocks (semantic tags R28): the same, and a pointer to
 * each `:::constraint` outside the sections that applies nowhere in the view. The ones that apply are shown in full
 * under "Constraints that apply here". A document without constraint blocks keeps `constraints/1`.
 */

export interface ConstraintPointer {
  type: 'danger' | 'warning' | 'decision' | 'question' | 'include' | 'constraint';
  /** The block's title as plain words; an include's file. */
  title: string;
  /** Zero-based line of the block's opening line. */
  line: number;
  /** The innermost heading above it. */
  section: string | null;
  /** A constraint's id, when it has one. */
  id?: string;
}

export interface ConstraintView {
  policy: 'constraints/1' | 'constraints/2';
  /** False when an include outside the sections was not checked, so a constraint could be missing. */
  complete: boolean;
  /** How many danger blocks are shown in full. */
  shown: number;
  /** Every constraint found outside the sections, the shown danger blocks too, in document order. */
  pointers: ConstraintPointer[];
}

const LABELS: Record<Exclude<ConstraintPointer['type'], 'danger'>, string> = {
  warning: 'warning',
  decision: 'accepted decision',
  question: 'open question',
  include: 'included file',
  constraint: 'constraint',
};

/** The constraints part of a view: the danger blocks' agent view, then a pointer per other constraint. */
export function constraintBlock(dangers: string, view: ConstraintView, lineRefs: boolean): string {
  const listed = view.pointers.filter((p) => p.type !== 'danger');
  if (!dangers && !listed.length) return '';
  const out = ['Constraints elsewhere in the document:'];
  if (dangers) out.push(dangers);
  if (listed.length) {
    out.push('Not shown here (read them if they bear on the task):');
    for (const p of listed) out.push(`- ${pointerText(p, lineRefs)}`);
  }
  return out.join('\n');
}

function pointerText(p: ConstraintPointer, lineRefs: boolean): string {
  const ref = lineRefs ? ` [L${p.line + 1}]` : '';
  const where = p.section ? ` in "${p.section}"` : '';
  if (p.type === 'include') return `${LABELS.include} ${p.title || '(no file)'}${ref}${where}: not checked for constraints`;
  const id = p.id ? ` ${p.id}` : '';
  return `${LABELS[p.type as keyof typeof LABELS]}${id}${p.title ? ` "${p.title}"` : ''}${ref}${where}`;
}
