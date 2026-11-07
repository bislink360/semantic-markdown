/**
 * The evaluation corpus format (see README.md). A corpus is a folder with one folder per document:
 *
 *   <corpus>/corpus.json            optional: { "version": "…", "today": "YYYY-MM-DD" }
 *   <corpus>/<doc>/doc.md           plain Markdown
 *   <corpus>/<doc>/doc.smd          the same text plus Semantic Markdown markup
 *   <corpus>/<doc>/annotations.json AnnotationFile
 *   <corpus>/<doc>/tasks.json       TaskFile
 *
 * Line spans are 1-based and inclusive, as editors show them.
 */

/** `[start, end]`, 1-based, inclusive. */
export type Span = [number, number];

export const ITEM_KINDS = ['fact', 'constraint', 'negation', 'limit', 'decision-status', 'open-question'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * What must appear for an item to count as shown: a phrase, or a regular expression. Both are matched against
 * normalised text (lower case, `*_\`~` removed, quotes and dashes unified, whitespace collapsed); a regex gets the `i`
 * flag unless `flags` is given.
 */
export type Evidence = string | { regex: string; flags?: string };

/** One thing a reader needs from the document, found by an annotator who did not mark it up. */
export interface AnnotationItem {
  /** Stable id, unique in the document, e.g. `retry-limit`. */
  id: string;
  kind: ItemKind;
  /** Where the item is stated in each format. */
  md: Span;
  smd: Span;
  /** Every entry must appear for the item to be visible. Each must appear inside both spans. */
  evidence: Evidence[];
  /** Who annotated it (name or handle). */
  annotator: string;
  notes?: string;
}

export interface AnnotationFile {
  /** Annotation guide version or other provenance. */
  guide?: string;
  items: AnnotationItem[];
}

export const TASK_TYPES = ['fact-lookup', 'constraint-check', 'decision-status', 'open-question', 'qualification', 'edit-plan'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** An answer that breaks an annotated constraint, so it is counted as a constraint violation. */
export interface ViolationRule {
  /** The constraint, negation or limit item it breaks. */
  item: string;
  /** Answers (normalised exact match) that break it. */
  answers: string[];
}

interface TaskBase {
  /** Unique across the corpus, e.g. `webhooks-03`. */
  id: string;
  type: TaskType;
  prompt: string;
  /** The annotation items the task is about. */
  items: string[];
  /** Who wrote the task (from the annotations, never from an agent view). */
  author?: string;
  notes?: string;
  violations?: ViolationRule[];
}

/** Correct when the answer equals one of `accepted` after normalising. */
export interface FactLookupTask extends TaskBase {
  type: 'fact-lookup';
  expected: { accepted: string[] };
}

/**
 * Correct when the verdict equals one of `verdict` and the answer cites `constraint` (its id in `cited`, or a line
 * span that overlaps the item's span in the format the condition shows). A wrong verdict counts as a violation.
 */
export interface ConstraintCheckTask extends TaskBase {
  type: 'constraint-check';
  expected: { verdict: string[]; constraint: string };
}

/** Correct when the option equals one of `option`; choosing one of `superseded` is also recorded on its own. */
export interface DecisionStatusTask extends TaskBase {
  type: 'decision-status';
  expected: { option: string[]; superseded: string[] };
}

/** Correct when the answer says the question is undecided and its fallback equals one of `fallback`. */
export interface OpenQuestionTask extends TaskBase {
  type: 'open-question';
  expected: { fallback: string[] };
}

/** Not scored automatically: written to judge packets with the rubric. */
export interface QualificationTask extends TaskBase {
  type: 'qualification';
  expected: { rubric: Array<{ id: string; text: string; items?: string[] }> };
}

/** Scored by line precision and recall against the spans of the format the condition shows. */
export interface EditPlanTask extends TaskBase {
  type: 'edit-plan';
  expected: { md: Span[]; smd: Span[] };
}

export type Task = FactLookupTask | ConstraintCheckTask | DecisionStatusTask | OpenQuestionTask | QualificationTask | EditPlanTask;

export interface TaskFile {
  tasks: Task[];
}

export interface CorpusConfig {
  version?: string;
  /** "Today" for agent views (overdue dates), so renders are the same on every day. */
  today?: string;
}

/** One line of answers.jsonl, written by the model harness. */
export interface AnswerRecord {
  task: string;
  /** Document folder name; only needed if task ids are not unique. */
  doc?: string;
  condition: string;
  run: number | string;
  seed?: number | string;
  model?: string;
  /**
   * A string, or an object: `{ verdict }` (constraint check), `{ option }` (decision status), `{ undecided, fallback }`
   * (open question), `{ text }` (anything else), `{ lines }` (edit plan).
   */
  answer: string | AnswerObject;
  /** Annotation ids the answer cites. */
  cited?: string[];
  /** Line spans the answer cites or plans to change, in the format the condition showed. */
  lines?: Span[];
  /** Token counts the provider reported, as given (input/output under any common name). */
  usage?: Record<string, number>;
  /** Tool calls the model made (the `run` command records it; the scorer ignores it). */
  toolCalls?: number;
  /**
   * Set by the `run` command when the answer is not a clean JSON object: `parse` (no JSON object found; `answer` is
   * the raw text), `tool-limit` (the model kept calling tools past the limit) or `empty` (no text). Scored as given.
   */
  error?: string;
}

export interface AnswerObject {
  text?: string;
  verdict?: string;
  option?: string;
  undecided?: boolean;
  fallback?: string;
  lines?: Span[];
}
