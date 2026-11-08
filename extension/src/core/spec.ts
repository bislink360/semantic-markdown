/**
 * The Semantic Markdown vocabulary. Everything the renderer, validator,
 * completion provider and converters know about lives here, so the format
 * has exactly one source of truth.
 *
 * Every table is read-only (since 2.0): its type says so, and it is deeply frozen when this module loads (see the
 * end of the file), so code that changes one fails, with a TypeError in strict mode. Copy a table to change it.
 */

/**
 * The spec version new documents are written with (since 2.0, `smd: 2`): by `smd init`'s templates, `smd from-md`,
 * `smd decisions --md`, `smd report`, `smd tasks --gantt --smd` and the snippets. A writer that adds front matter to
 * an existing document keeps the rules it is read with unless spec v2 reads it the same (Set Document Status), and
 * the validator's fix for a missing `smd` key writes `smd: 1`, the version such a document is read with. The newest
 * version tools read is LATEST_SPEC (specVersion.ts).
 */
export const SMD_VERSION = 2;

/** Named colors. They map to CSS variables that adapt to light/dark themes. */
export const NAMED_COLORS = [
  'red', 'orange', 'amber', 'yellow', 'green', 'teal', 'cyan',
  'blue', 'indigo', 'purple', 'pink', 'gray', 'muted', 'accent',
] as const;

export const DECISION_STATUS: readonly string[] = ['proposed', 'accepted', 'rejected', 'superseded', 'deprecated'];
export const RISK_LEVELS: readonly string[] = ['low', 'medium', 'high', 'critical'];
export const RISK_STATUS: readonly string[] = ['open', 'mitigated', 'accepted', 'closed'];
export const HTTP_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'WS', 'RPC', 'EVENT'];
export const PRIORITY_VALUES: readonly string[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'critical', 'high', 'medium', 'low'];

// Semantic tags (RFC phases 1 and 2) and review blocks (collaboration RFC phase 3). People write these states:
// no tool moves a requirement to `verified` or a question to `answered` by itself (research contract, "Lifecycle").
export const REQUIREMENT_STATUS: readonly string[] = ['proposed', 'accepted', 'implemented', 'verified', 'deprecated'];
export const CONSTRAINT_SCOPES: readonly string[] = ['document', 'section'];
export const CONSTRAINT_LEVELS: readonly string[] = ['must', 'should'];
export const ASSUMPTION_STATUS: readonly string[] = ['unvalidated', 'validated', 'invalid'];
export const EVIDENCE_RESULTS: readonly string[] = ['pass', 'fail', 'inconclusive'];
/** Evidence methods tools know. `acceptance` is a person accepting the result (research contract, "Tasks"). Any other value is allowed. */
export const EVIDENCE_METHODS: readonly string[] = ['test', 'review', 'benchmark', 'manual', 'analysis', 'acceptance'];
export const QUESTION_STATUS: readonly string[] = ['open', 'answered', 'incorporated', 'withdrawn'];
export const COMMENT_KINDS: readonly string[] = ['remark', 'answer', 'correction'];
export const COMMENT_STATUS: readonly string[] = ['open', 'resolved'];
export const SUGGESTION_STATUS: readonly string[] = ['open', 'accepted', 'rejected', 'withdrawn'];
// Semantic tags phase 3 (RFC D10, D11).
export const EXAMPLE_KINDS: readonly string[] = ['do', 'dont'];
export const LIMITATION_STATUS: readonly string[] = ['open', 'mitigated', 'resolved'];
/** `:progress{basis=…}`: what a percentage counts (research AF25). `tasks` counts the checked tasks of the section. */
export const PROGRESS_BASES: readonly string[] = ['tasks', 'measured', 'estimate'];

export const CALLOUT_TYPES = ['note', 'info', 'tip', 'success', 'warning', 'danger', 'question'] as const;

/** `:::figure{kind=…}` values. Each kind has its own label and counter: Figure 1, Table 1, Listing 1. */
export const FIGURE_KINDS: readonly string[] = ['figure', 'table', 'listing'];

export interface ContainerSpec {
  readonly description: string;
  /** Attribute keys accepted on the opening line, beyond the shared style keys. */
  readonly attrs?: readonly string[];
  /** Must be nested directly inside this container. */
  readonly parent?: string;
  /** Title text after the name is meaningful. */
  readonly title?: boolean;
  /** Allowed values for enumerated attributes. */
  readonly values?: Readonly<Record<string, readonly string[]>>;
  /** Attributes that must be present. */
  readonly required?: readonly string[];
  /**
   * Values an attribute has when it is not written (semantic tags R2). Query results and the agent view read them
   * from here. Only the tags added in 4.1 use it, so older blocks keep their released query output.
   */
  readonly defaults?: Readonly<Record<string, string>>;
}

const callout = (label: string): ContainerSpec => ({
  description: `${label} callout. Optional title after the name.`,
  title: true,
  attrs: ['title', 'collapsible'],
});

export const CONTAINERS: Readonly<Record<string, ContainerSpec>> = {
  note: callout('Neutral note'),
  info: callout('Informational'),
  tip: callout('Helpful tip'),
  success: callout('Success / done'),
  warning: callout('Warning'),
  danger: callout('Danger / breaking'),
  question: {
    ...callout('Open question'),
    attrs: ['title', 'collapsible', 'status', 'owner', 'due', 'between', 'reason', 'by', 'on'],
    values: { status: QUESTION_STATUS },
  },
  details: { description: 'Collapsible section. Title after the name is the summary.', title: true, attrs: ['title', 'open'] },
  card: { description: 'Bordered card with optional title and accent color.', title: true, attrs: ['title', 'accent'] },
  box: { description: 'Generic styled block — use style attributes (bg, color, border, align...).', title: false },
  tabs: { description: 'Tab group. Contains :::tab children (writing the outer fence as ::::tabs helps readability).' },
  tab: { description: 'One tab inside ::::tabs. Title after the name is the tab label.', parent: 'tabs', title: true, attrs: ['title'] },
  columns: { description: 'Side-by-side layout. Contains :::column children.' },
  column: { description: 'One column inside ::::columns.', parent: 'columns', attrs: ['width'] },
  steps: { description: 'Renders the ordered list inside as numbered, connected steps.' },
  agent: {
    description: 'Content addressed to AI agents (instructions, constraints, context). Collapsed for humans in the preview.',
    title: true,
    attrs: ['title'],
  },
  human: { description: 'Content addressed only to human readers. Agents may skip it.', title: true, attrs: ['title'] },
  include: {
    description: 'Transclusion: the body of another .smd file, or one section of it, in place of this block. ' +
      'file="…" is relative to this document; section="…" is a heading\'s text or id; level=N makes its top heading level N. ' +
      'The block\'s own body is fallback text (e.g. a link to the file) for renderers that cannot include.',
    attrs: ['file', 'section', 'level'],
  },

  // Product / project management
  decision: {
    description: 'Decision record (ADR-style): what was decided, by whom, when. Title = the decision.',
    title: true,
    attrs: ['title', 'status', 'date', 'owner', 'supersedes', 'depends-on'],
    values: { status: DECISION_STATUS },
  },
  risk: {
    description: 'Risk with impact and likelihood. Body = description and mitigation.',
    title: true,
    attrs: ['title', 'impact', 'likelihood', 'owner', 'status', 'depends-on'],
    values: { impact: RISK_LEVELS, likelihood: RISK_LEVELS, status: RISK_STATUS },
  },
  'risk-matrix': {
    description: 'Impact × likelihood matrix of the :::risk blocks in this document (closed risks left out). Title after the name; usually no body.',
    title: true,
    attrs: ['title'],
  },
  timeline: { description: 'Renders the list inside as a vertical timeline (start items with a date).' },
  changelog: {
    description: 'Release history: each heading inside is a release, "## 1.2.0 — 2026-03-01" (newest first), followed by its notes. ' +
      'Rendered as a timeline of versions with dates. Title after the name.',
    title: true,
    attrs: ['title'],
  },
  figure: {
    description: 'Numbered figure around an image, diagram, table or code block. Title = the caption; give it an {#id} to refer to it with :ref[id].',
    title: true,
    attrs: ['title', 'kind'],
    values: { kind: FIGURE_KINDS },
  },
  quote: {
    description: 'Quotation with attribution: the body is the quoted text. author="…" and source="…" make the "— Author, Source" line; ' +
      'cite="…" is the http(s) or relative URL it comes from. Not numbered as a figure.',
    attrs: ['author', 'source', 'cite'],
  },
  glossary: {
    description: 'Glossary: a list of **Term**: definition items, rendered as a definition list. The first use of each term in a section shows its definition on hover and links to it.',
    title: true,
    attrs: ['title'],
  },

  // Semantic tags (RFC phase 1: requirement, constraint, acceptance. Phase 2: assumption, evidence)
  requirement: {
    description: 'A required behavior. Title = the requirement in one sentence, body = detail and rationale. Give it an {#id}.',
    title: true,
    attrs: ['title', 'priority', 'status', 'owner', 'depends-on'],
    values: { priority: PRIORITY_VALUES, status: REQUIREMENT_STATUS },
    defaults: { status: 'proposed' },
  },
  constraint: {
    description: 'A restriction work must respect. scope=document keeps it in every agent view, applies-to=… names the blocks it binds.',
    title: true,
    attrs: ['title', 'scope', 'applies-to', 'level', 'owner', 'depends-on'],
    values: { scope: CONSTRAINT_SCOPES, level: CONSTRAINT_LEVELS },
    defaults: { scope: 'section', level: 'must' },
  },
  acceptance: {
    description: 'Observable conditions (Given/When/Then) that say how to check a requirement: verifies=… or nested in it. Not evidence that it passed.',
    title: true,
    attrs: ['title', 'verifies', 'test'],
  },
  assumption: {
    description: 'An unverified premise, with an owner and a review-by date.',
    title: true,
    attrs: ['title', 'status', 'owner', 'review-by', 'depends-on'],
    values: { status: ASSUMPTION_STATUS },
    defaults: { status: 'unvalidated' },
  },
  evidence: {
    description: 'The basis for or against a block (supports=… or contradicts=…), with the method, result, commit and date that produced it. method=acceptance records a person accepting the result.',
    title: true,
    attrs: ['title', 'supports', 'contradicts', 'method', 'result', 'source', 'commit', 'date', 'by', 'rev'],
    values: { result: EVIDENCE_RESULTS },
  },
  // Semantic tags phase 3 (RFC D10, D11)
  'non-goals': {
    description: 'A list of what the work leaves out on purpose. Kept in every agent view and never dropped by a token budget, like :::agent.',
    title: true,
    attrs: ['title'],
  },
  example: {
    description: 'A good (kind=do) or bad (kind=dont) example. Agents see kind="dont" on the tag, so a bad example is never copied as guidance.',
    title: true,
    attrs: ['title', 'kind'],
    values: { kind: EXAMPLE_KINDS },
  },
  limitation: {
    description: 'Something that does not work, does not hold or has not been checked: a known issue or a threat to validity. affects=… names the blocks it limits.',
    title: true,
    attrs: ['title', 'status', 'affects', 'owner'],
    values: { status: LIMITATION_STATUS },
    defaults: { status: 'open' },
  },
  deprecated: {
    description: 'Content that still works but should not be used for new work: since=… is the version that deprecated it, use="…" what to use instead.',
    title: true,
    attrs: ['title', 'since', 'use'],
  },

  // Review (collaboration RFC phase 3)
  comment: {
    description: 'A review comment on the block with id for=…, written by author=… against its revision rev=…. kind=answer answers a question.',
    title: true,
    attrs: ['title', 'for', 'author', 'date', 'rev', 'kind', 'status', 'by', 'on'],
    values: { kind: COMMENT_KINDS, status: COMMENT_STATUS },
    defaults: { kind: 'remark', status: 'open' },
  },
  suggestion: {
    description: 'A proposed replacement for the body of the block with id for=…, against its revision rev=…. Accepting or rejecting it records by=… and on=….',
    title: true,
    attrs: ['title', 'for', 'author', 'date', 'rev', 'status', 'by', 'on', 'reason'],
    values: { status: SUGGESTION_STATUS },
    defaults: { status: 'open' },
  },

  // Developer
  api: {
    description: 'API endpoint: method + path header, body documents parameters and responses.',
    title: true,
    attrs: ['title', 'method', 'path', 'auth'],
    values: { method: HTTP_METHODS },
    required: ['method', 'path'],
  },
};

/** Style keys accepted on any attribute list: [text]{...}, :::box{...}, etc. */
export const STYLE_KEYS: Readonly<Record<string, string>> = {
  color: 'Text color: a named color (red, blue…) or #hex / rgb()',
  bg: 'Background color: a named color or #hex / rgb()',
  border: 'Border color: a named color or #hex',
  size: 'Font size: xs | sm | md | lg | xl | 2xl',
  weight: 'Font weight: normal | medium | bold',
  font: 'Font family: sans | serif | mono',
  align: 'Text alignment (blocks): left | center | right',
  style: 'Text decoration: italic | underline | strike',
};

export const SIZE_VALUES: Readonly<Record<string, string>> = {
  xs: '0.75em', sm: '0.875em', md: '1em', lg: '1.25em', xl: '1.5em', '2xl': '2em',
};
export const WEIGHT_VALUES: Readonly<Record<string, string>> = { normal: '400', medium: '500', bold: '700' };
export const FONT_VALUES: Readonly<Record<string, string>> = {
  sans: 'var(--smd-font-sans)', serif: 'var(--smd-font-serif)', mono: 'var(--smd-font-mono)',
};
export const ALIGN_VALUES: readonly string[] = ['left', 'center', 'right'];
export const TEXT_STYLE_VALUES: Readonly<Record<string, string>> = {
  italic: 'font-style:italic', underline: 'text-decoration:underline', strike: 'text-decoration:line-through',
};

export interface InlineDirectiveSpec {
  readonly description: string;
  /** Whether [content] is required. */
  readonly content: boolean;
  readonly attrs: readonly string[];
  readonly example: string;
  /** Allowed values for enumerated attributes. */
  readonly values?: Readonly<Record<string, readonly string[]>>;
}

export const INLINE_DIRECTIVES: Readonly<Record<string, InlineDirectiveSpec>> = {
  badge: { description: 'Colored pill label', content: true, attrs: ['color'], example: ':badge[Shipped]{color=green}' },
  kbd: { description: 'Keyboard key', content: true, attrs: [], example: ':kbd[Ctrl+Shift+P]' },
  progress: {
    description: 'Progress bar, value 0–100 or unknown. basis=tasks counts the checked tasks of its section; measured or estimate says how value was found',
    content: false,
    attrs: ['value', 'color', 'label', 'basis'],
    values: { basis: PROGRESS_BASES },
    example: ':progress{value=60 basis=estimate}',
  },
  mention: { description: 'Person or team mention', content: true, attrs: [], example: ':mention[@platform-team]' },
  status: {
    description: 'Status dot + label',
    content: true,
    attrs: ['color'],
    example: ':status[On track]{color=green}',
  },
  priority: { description: 'Priority pill, colored automatically (P0–P4 or critical/high/medium/low)', content: true, attrs: [], example: ':priority[P1]' },
  due: { description: 'Due date (YYYY-MM-DD); shown red when overdue, amber when due within 7 days', content: true, attrs: [], example: ':due[2026-10-15]' },
  metric: {
    description: 'KPI tile: value, label and optional delta/trend',
    content: true,
    attrs: ['label', 'delta', 'trend', 'good'],
    values: { trend: ['up', 'down', 'flat'], good: ['up', 'down'] },
    example: ':metric[42%]{label="Activation" delta="+3%" trend=up}',
  },
  ref: {
    description: 'Numbered reference to a :::figure by its id: renders "Figure 2" as a link to it',
    content: true,
    attrs: [],
    example: ':ref[fig-checkout]',
  },
  depends: {
    description: 'On a task (spec v2): the ids of the blocks it waits for, comma-separated',
    content: true,
    attrs: [],
    example: ':depends[R1]',
  },
  since: {
    description: 'Version label (spec v2): the version a feature or behavior appeared in',
    content: true,
    attrs: [],
    example: ':since[1.6]',
  },
};

/**
 * The inline directives spec v1 reads, frozen for good (semantic tags RFC, D5). New directives exist only in spec v2,
 * so adding one to INLINE_DIRECTIVES changes no `smd: 1` document, and `smd migrate --to 2` keeps escaping v1 text
 * such as `:since[1.6]`. Never add a name here.
 */
export const V1_DIRECTIVES: readonly string[] = ['badge', 'kbd', 'progress', 'mention', 'status', 'priority', 'due', 'metric', 'ref'];

/**
 * Attributes whose value names blocks by id, one id or a comma-separated list (`verifies=R1,R2`, semantic tags R15),
 * with the containers that take each. The validator checks every id they name (`ref/unknown`, `ref/ambiguous`).
 * Phase 2 added `depends-on`, `supports`, `contradicts`, `supersedes` and `between`, and the review blocks `for`. Phase 3
 * added `affects` on `:::limitation`.
 */
export const ID_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  verifies: ['acceptance'],
  'applies-to': ['constraint'],
  'depends-on': ['requirement', 'constraint', 'decision', 'risk', 'assumption'],
  supports: ['evidence'],
  contradicts: ['evidence'],
  supersedes: ['decision'],
  between: ['question'],
  for: ['comment', 'suggestion'],
  affects: ['limitation'],
};

/**
 * The kind of each edge: the id attributes and the edges derived from links, `:ref`, `related:` and includes
 * (research contract, "Edge semantics"). Only mandatory edges expand automatically. Navigation, evidence and review
 * edges come back as pointers, and lifecycle edges never expand.
 */
export const EDGE_KINDS: Readonly<Record<string, 'navigation' | 'mandatory' | 'evidence' | 'lifecycle' | 'review'>> = {
  link: 'navigation',
  ref: 'navigation',
  related: 'navigation',
  include: 'mandatory',
  'applies-to': 'mandatory',
  'depends-on': 'mandatory',
  verifies: 'evidence',
  supports: 'evidence',
  contradicts: 'evidence',
  supersedes: 'lifecycle',
  between: 'lifecycle',
  for: 'review',
  affects: 'evidence',
};

/**
 * Enumerated attributes added in 4.1, by block (`:::question`) or directive (`:progress`). Before 4.1 a value written
 * there was only an unknown attribute, a warning, so an invalid value stays a warning until the next major release
 * instead of becoming an `attrs/value` error (a valid document must not become invalid in a minor release).
 */
export const NEW_VALUE_KEYS: Readonly<Record<string, readonly string[]>> = {
  ':::question': ['status'],
  ':::requirement': ['priority', 'status'],
  ':::constraint': ['scope', 'level'],
  ':::assumption': ['status'],
  ':::evidence': ['result'],
  ':::comment': ['kind', 'status'],
  ':::suggestion': ['status'],
  ':::example': ['kind'],
  ':::limitation': ['status'],
  ':progress': ['basis'],
};

/** The severity of an invalid enumerated value: a warning on the attributes added in 4.1, an error elsewhere. */
export function valueSeverity(block: string, key: string): 'error' | 'warning' {
  return (Object.hasOwn(NEW_VALUE_KEYS, block) && NEW_VALUE_KEYS[block].includes(key)) ? 'warning' : 'error';
}

/** The ids an id attribute's value lists: `R1,R2` and `"R1, R2"` are both `R1` and `R2`. */
export function idList(value: string): string[] {
  return value.split(',').map((id) => id.trim()).filter(Boolean);
}

/** Whether `name` (as written in spec v1, lower-cased in v2) is a directive of the vocabulary in spec version `spec`. */
export function isKnownDirective(name: string, spec: number): boolean {
  return spec >= 2 ? Object.hasOwn(INLINE_DIRECTIVES, name) : V1_DIRECTIVES.includes(name);
}

/**
 * Front matter variables (spec §4.7): `{{name}}` in text shows the value of the front matter key `name`.
 * Only names the front matter defines are replaced; `\{{name}}` and code keep the braces.
 */
export const VARIABLE_SYNTAX = {
  description: 'Front matter variable: shows the value of this front matter key (nested keys with dots, e.g. {{owner.name}}). Names the front matter does not define stay as written.',
  example: 'Version {{version}}',
} as const;

/** Known front-matter keys. Unknown keys are allowed but reported as hints. */
export const FRONTMATTER_KEYS: Readonly<Record<string, string>> = {
  smd: 'Semantic Markdown spec version: 1, or 2 for the spec v2 rules (a document without it is version 1)',
  title: 'Document title',
  summary: 'One or two sentence summary — agents read this first',
  status: 'draft | review | approved | deprecated | archived',
  owners: 'List of owners (people or teams)',
  audience: 'Who it is for: humans | agents | both',
  tags: 'List of tags',
  version: 'Document version',
  updated: 'Last updated date (YYYY-MM-DD)',
  created: 'Created date (YYYY-MM-DD)',
  theme: 'Preview theme hint: auto | light | dark',
  accent: 'Accent color used for headings and links (named color or #hex)',
  toc: 'true to render a table of contents after the header',
  related: 'List of related documents (paths or URLs)',
  lang: 'Language of the rendered labels (callout titles, "Figure 2", "overdue"…), a BCP 47 tag such as de or pt-BR. Default English',
  typography: 'Spec v2: true turns on typographic quotes, dashes and ellipses (v1 always has them)',
  views: 'Named task views for agents: each selects sections or a query and lists mandatory and optional block ids (smd agent --view name)',
};

export const STATUS_VALUES: readonly string[] = ['draft', 'review', 'approved', 'deprecated', 'archived'];
export const AUDIENCE_VALUES: readonly string[] = ['humans', 'agents', 'both'];

export const MERMAID_TYPES: readonly string[] = [
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'stateDiagram-v2',
  'erDiagram', 'journey', 'gantt', 'pie', 'quadrantChart', 'requirementDiagram', 'gitGraph',
  'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment', 'mindmap', 'timeline',
  'zenuml', 'sankey-beta', 'sankey', 'xychart-beta', 'xychart', 'block-beta', 'block', 'packet-beta',
  'packet', 'kanban', 'architecture-beta', 'architecture', 'radar-beta', 'treemap-beta',
];

/** Freeze `value`, and every object and array in it. */
function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
}

// The shared tables, frozen once so no caller (in this package or using it) can change them for everyone else.
deepFreeze([
  NAMED_COLORS, DECISION_STATUS, RISK_LEVELS, RISK_STATUS, HTTP_METHODS, PRIORITY_VALUES, CALLOUT_TYPES, FIGURE_KINDS, CONTAINERS,
  REQUIREMENT_STATUS, CONSTRAINT_SCOPES, CONSTRAINT_LEVELS, ASSUMPTION_STATUS, EVIDENCE_RESULTS, EVIDENCE_METHODS, QUESTION_STATUS,
  COMMENT_KINDS, COMMENT_STATUS, SUGGESTION_STATUS, PROGRESS_BASES, EDGE_KINDS, NEW_VALUE_KEYS,
  STYLE_KEYS, SIZE_VALUES, WEIGHT_VALUES, FONT_VALUES, ALIGN_VALUES, TEXT_STYLE_VALUES, INLINE_DIRECTIVES, V1_DIRECTIVES, ID_ATTRIBUTES, VARIABLE_SYNTAX,
  FRONTMATTER_KEYS, STATUS_VALUES, AUDIENCE_VALUES, MERMAID_TYPES,
]);
