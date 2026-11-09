// The study log's event schema (Study 2, research requirements AF31 and AF35). Only a study build of the extension
// logs (see build.mjs --study), and only for a session someone turned on. Every event passes through
// sanitizeStudyEvent, which keeps only the fields its type allows and only values of the right shape: numbers,
// booleans, words from fixed lists and identifiers. No field can carry document text, a file path or a user name.
// No `vscode` import, so the unit tests can check it.

/** Bumped when an event's fields change meaning. Every line carries it as `v`. */
export const STUDY_SCHEMA_VERSION = 1;

/** The events a study session records. */
export const STUDY_EVENTS = [
  'session.start', // logging turned on: how, and the extension version
  'session.end', // logging turned off or VS Code closed: duration and active time
  'heartbeat', // once a minute while logging, with the active time so far
  'focus', // the VS Code window gained or lost focus
  'view.active', // the active tab changed: which view of which document
  'preview.open', // a preview panel opened on a document
  'cue.render', // the cues a rendered preview holds (kinds, lines, ids and states), when they change
  'cue.visible', // a cue was at least half on screen in the preview for a while (dwell time)
  'cue.toggle', // a collapsible cue (details, agent block, collapsible callout) was opened or closed
  'task.toggle', // a task checkbox was checked or unchecked (a completion claim)
  'review', // a review button in the Block Editor: accept, reject, resolve or rebase a comment or suggestion
  'block.insert', // a block inserted from a Block Editor template
  'status.set', // a block's status attribute set in the Block Editor (for example a question marked answered)
  'reveal', // went from a rendered block to its source line
  'agentview.open', // opened the live agent view, full or brief
  'omissions.open', // opened "What the Agent View Leaves Out", with counts by kind
  'omissions.choose', // chose one omission to go to its source lines
  'omissions.dismiss', // closed the omission list without choosing
  'edit', // text edits, coalesced: line range and sizes, never the text
  'validate', // the validator's diagnostics for a document changed: counts and rule codes
] as const;

export type StudyEventType = (typeof STUDY_EVENTS)[number];

/** Where an event happened. */
export const STUDY_VIEWS = ['text', 'preview', 'block-editor', 'agent', 'agent-brief', 'omissions', 'other'] as const;

/**
 * Block and omission kinds that may be logged. Cue kinds are the container names the renderer and `smd query` use;
 * omission kinds are the provenance manifest's.
 */
export const STUDY_KINDS = [
  // cues and blocks
  'question', 'danger', 'warning', 'caution', 'note', 'info', 'tip', 'success', 'important', 'decision', 'risk',
  'requirement', 'constraint', 'acceptance', 'assumption', 'evidence', 'agent', 'human', 'details', 'comment',
  'suggestion', 'task', 'timeline', 'progress', 'callout', 'deprecated', 'limitation', 'example', 'other',
  // omission kinds (core/provenance.ts)
  'skipped-section', 'not-selected', 'budget', 'diagram', 'code', 'completed-tasks', 'include', 'embed', 'outline',
  'dependency',
] as const;

/** Review and editing actions. */
export const STUDY_ACTIONS = ['accept', 'reject', 'resolve', 'rebase'] as const;

/** States a cue or task can be in. */
export const STUDY_STATES = ['open', 'closed', 'done', 'undone'] as const;

/** Status attribute values from the spec's fixed lists (questions, decisions, comments, suggestions, requirements). */
export const STUDY_STATUSES = [
  'open', 'answered', 'incorporated', 'withdrawn', 'proposed', 'accepted', 'rejected', 'superseded', 'deprecated',
  'resolved', 'draft', 'approved', 'implemented', 'verified', 'done', 'blocked', 'stale', 'other',
] as const;

/** Comment kinds (spec COMMENT_KINDS). */
export const STUDY_COMMENT_KINDS = ['remark', 'answer', 'correction'] as const;

/** How a session was turned on or off. */
export const STUDY_REASONS = ['env', 'command', 'stopped', 'deactivate', 'restart'] as const;

type Check = (value: unknown) => boolean;

const isInt = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const isBool = (v: unknown) => typeof v === 'boolean';
const oneOf = (list: readonly string[]): Check => (v) => typeof v === 'string' && list.includes(v);
const matches = (re: RegExp, max: number): Check => (v) => typeof v === 'string' && v.length <= max && re.test(v);

/** A salted hash of a document's URI: 16 hex digits. */
const DOC_ID = /^[0-9a-f]{16}$/;
/**
 * A study fixture's file name, which the study team chose: `s2-…` and `.smd` or `.md`. Any other file is logged by
 * its hashed id only.
 */
export const FIXTURE_NAME = /^s2-[a-z0-9][a-z0-9-]{0,60}\.(?:smd|md)$/;
/** A block id as written in `{#id}` or `for=`: an identifier, never prose (no spaces). */
const BLOCK_ID = /^[A-Za-z][\w.:-]{0,63}$/;
/** A template's name as a slug (`agent-block`). Templates come from the extension's own snippets. */
const SLUG = /^[a-z][a-z0-9-]{0,40}$/;
/** A validator rule code (`unknown-container`, `SMD012`). */
const CODE = /^[A-Za-z][\w-]{0,40}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,20})?$/;

// Every top-level call is marked pure, so a release build, which never calls into the study code, drops the module.
const kindCheck = /* @__PURE__ */ oneOf(STUDY_KINDS);
const statusCheck = /* @__PURE__ */ oneOf(STUDY_STATUSES);

const isCue = (v: unknown): boolean => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const cue = v as Record<string, unknown>;
  return Object.keys(cue).every((k) => ['kind', 'line', 'block', 'status', 'state'].includes(k))
    && kindCheck(cue.kind) && isInt(cue.line)
    && (cue.block === undefined || (typeof cue.block === 'string' && BLOCK_ID.test(cue.block)))
    && (cue.status === undefined || statusCheck(cue.status))
    && (cue.state === undefined || oneOf(STUDY_STATES)(cue.state));
};

/** Each field that may appear in an event, and the shape its value must have. */
export const STUDY_FIELDS: Readonly<Record<string, Check>> = /* @__PURE__ */ (() => ({
  doc: matches(DOC_ID, 16),
  fixture: matches(FIXTURE_NAME, 70),
  view: oneOf(STUDY_VIEWS),
  kind: kindCheck,
  block: matches(BLOCK_ID, 64),
  line: isInt,
  lineEnd: isInt,
  action: oneOf(STUDY_ACTIONS),
  state: oneOf(STUDY_STATES),
  status: statusCheck,
  commentKind: oneOf(STUDY_COMMENT_KINDS),
  template: matches(SLUG, 41),
  reason: oneOf(STUDY_REASONS),
  version: matches(VERSION, 40),
  count: isInt,
  changes: isInt,
  inserted: isInt,
  deleted: isInt,
  durationMs: isInt,
  activeMs: isInt,
  errors: isInt,
  warnings: isInt,
  infos: isInt,
  focused: isBool,
  applied: isBool,
  own: isBool,
  codes: (v) => Array.isArray(v) && v.length <= 50 && v.every(matches(CODE, 41)),
  counts: (v) => !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length <= STUDY_KINDS.length
    && Object.entries(v).every(([k, n]) => kindCheck(k) && isInt(n)),
  cues: (v) => Array.isArray(v) && v.length <= 500 && v.every(isCue),
}))();

const DOC = ['doc', 'fixture'];

/** The fields each event may carry, besides the envelope (v, session, seq, t, ms). */
export const STUDY_EVENT_FIELDS: Readonly<Record<StudyEventType, readonly string[]>> = /* @__PURE__ */ (() => ({
  'session.start': ['reason', 'version'],
  'session.end': ['reason', 'durationMs', 'activeMs'],
  heartbeat: ['activeMs'],
  focus: ['focused', 'activeMs'],
  'view.active': [...DOC, 'view'],
  'preview.open': [...DOC, 'view'],
  'cue.render': [...DOC, 'view', 'count', 'counts', 'cues'],
  'cue.visible': [...DOC, 'view', 'kind', 'line', 'block', 'status', 'durationMs'],
  'cue.toggle': [...DOC, 'view', 'kind', 'line', 'block', 'state'],
  'task.toggle': [...DOC, 'view', 'line', 'applied'],
  review: [...DOC, 'view', 'action', 'kind', 'commentKind', 'line', 'block', 'applied'],
  'block.insert': [...DOC, 'view', 'template', 'applied'],
  'status.set': [...DOC, 'view', 'kind', 'status', 'line', 'block', 'applied'],
  reveal: [...DOC, 'view', 'line'],
  'agentview.open': [...DOC, 'view'],
  'omissions.open': [...DOC, 'view', 'count', 'counts'],
  'omissions.choose': [...DOC, 'view', 'kind', 'line', 'lineEnd', 'own'],
  'omissions.dismiss': [...DOC, 'view'],
  edit: [...DOC, 'view', 'line', 'lineEnd', 'changes', 'inserted', 'deleted', 'durationMs'],
  validate: [...DOC, 'errors', 'warnings', 'infos', 'codes'],
}))();

/** An event as written: the envelope, then the type's fields. */
export interface StudyEvent {
  v: number;
  session: string;
  seq: number;
  /** ISO time. */
  t: string;
  /** Milliseconds since the session started. */
  ms: number;
  type: StudyEventType;
  [field: string]: unknown;
}

export interface SanitizedFields {
  type: StudyEventType;
  fields: Record<string, unknown>;
  /** The names of the fields that were left out: not allowed for the type, or not of the allowed shape. */
  dropped: string[];
}

/**
 * The fields an event may keep. Undefined when the type isn't a study event. A field the type doesn't allow, or
 * whose value isn't of its shape (free text, a path, a name), is dropped and named in `dropped`. Undefined values
 * are skipped silently.
 */
export function sanitizeStudyEvent(type: unknown, raw: Readonly<Record<string, unknown>>): SanitizedFields | undefined {
  if (typeof type !== 'string' || !(STUDY_EVENTS as readonly string[]).includes(type)) return undefined;
  const allowed = STUDY_EVENT_FIELDS[type as StudyEventType];
  const fields: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const check = STUDY_FIELDS[name];
    if (allowed.includes(name) && check?.(value)) fields[name] = value;
    else dropped.push(name);
  }
  return { type: type as StudyEventType, fields, dropped };
}

/** A status attribute's value as a logged status: one of the fixed list, else `other`. */
export function studyStatus(value: unknown): (typeof STUDY_STATUSES)[number] | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const v = value.toLowerCase();
  return (STUDY_STATUSES as readonly string[]).includes(v) ? (v as (typeof STUDY_STATUSES)[number]) : 'other';
}

/** A block type as a logged kind: one of the fixed list, else `other`. */
export function studyKind(value: unknown): (typeof STUDY_KINDS)[number] | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const v = value.toLowerCase();
  return (STUDY_KINDS as readonly string[]).includes(v) ? (v as (typeof STUDY_KINDS)[number]) : 'other';
}

/** A block id when it is an identifier, else nothing (an id is the only document-written string the log keeps). */
export function studyBlockId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && BLOCK_ID.test(value) ? value : undefined;
}

/** A study fixture's file name from a path or URI, or nothing when the file isn't named as a fixture. */
export function studyFixture(fileName: string): string | undefined {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  return FIXTURE_NAME.test(base) ? base : undefined;
}
