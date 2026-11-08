import { maskCodeSpans } from './footnotes';
import { suggest } from './util';
import type { Diagnostic, Severity } from './validate';

/** Every diagnostic code the validator reports, with what it checks. */
export const RULE_CODES: Record<string, string> = {
  'frontmatter/invalid': 'YAML front matter does not parse, is not a mapping, or is never closed',
  'frontmatter/version': '`smd` version missing, not a whole number, or newer than this tool knows',
  'frontmatter/unknown-key': 'Non-standard front matter key',
  'frontmatter/status': 'Invalid `status` value',
  'frontmatter/audience': 'Invalid `audience` value',
  'frontmatter/value': 'Value outside the allowed values for its key (e.g. `theme`)',
  'frontmatter/accent': 'Invalid `accent` color',
  'frontmatter/type': 'Front matter value has the wrong type',
  'frontmatter/date': 'Front matter date is not YYYY-MM-DD',
  'frontmatter/duplicate-title': 'The first `# heading` repeats the front matter title',
  'frontmatter/stale': '`updated` is older than the stale limit and the document is not archived or deprecated',
  'frontmatter/lang': '`lang` is not a language tag, or names a language without labels (they render in English)',
  'container/unknown': 'Unknown container name',
  'container/unclosed': 'Container is never closed, or (spec v2) has no closing fence of its own and closes with a container around it',
  'container/stray-close': 'Closing `:::` with nothing open',
  'container/parent': 'Container used outside its required parent (`tab` outside `tabs`…)',
  'container/colons': 'A closing fence has another colon count than the container it closes, which spec v2 pairs by count (in spec v2: no open container has its count)',
  'container/title-conflict': 'A container has both `title=` and title text after its attributes; the text is not shown',
  'container/agent-in-skip': '`:::agent` block inside a section marked `{agent=skip}`, which agent views leave out',
  'attrs/syntax': 'Malformed `{…}` attribute list',
  'attrs/unknown': 'Attribute not accepted in this position',
  'attrs/value': 'Invalid attribute value',
  'attrs/required': 'Required attribute missing',
  'attrs/duplicate': 'A key, `#id` or class is given twice in one attribute list; the last one is used',
  'heading/attrs-text': 'A heading ends in `{}` or in a list with a bare word (`{ok}`), which spec v2 reads as heading text',
  'directive/unknown': 'Unknown inline directive',
  'directive/content': 'Inline directive needs `[content]`',
  'mermaid/type': 'Unknown Mermaid diagram type',
  'mermaid/empty': 'Empty Mermaid diagram',
  'mermaid/acc-title': 'Mermaid diagram that screen readers can only call "Diagram": no `accTitle:`, no `:::figure` caption, no title of its own',
  'mermaid/syntax': 'Mermaid diagram does not parse (checked where a Mermaid parser is available: the editor and the CLI)',
  'math/syntax': 'KaTeX parse error',
  'math/unclosed': 'Display math `$$` is never closed',
  'fence/unclosed': 'Code fence is never closed',
  'fence/embed-missing': 'Embedded file is missing or outside the workspace',
  'fence/range': 'Invalid `lines="…"` range',
  'fence/embed-body': 'A `file="…"` embed has a non-empty body',
  'fence/lines-without-file': '`lines="…"` without `file="…"`',
  'include/missing-file': 'The `:::include` file does not exist',
  'include/outside-workspace': 'The `:::include` file is outside the folders the document may read, or unreadable',
  'include/missing-section': 'The `:::include` `section` matches no heading in the file',
  'include/cycle': 'Includes lead back to a document already being included',
  'include/depth': 'Includes nest more than 8 deep',
  'include/section-match': 'The `:::include` `section` finds a heading only by a part of its text; spec v2 matches an exact id or the whole text',
  'include/too-large': 'Includes read more than a document may (200 includes, 2,000,000 characters)',
  'id/duplicate': 'Two blocks share an id (a heading, task, container, figure or HTML element); links and feedback naming it resolve to neither',
  'link/ambiguous-anchor': 'Link to an `#anchor` that two or more blocks share, which resolves to none of them',
  'link/github-anchor': 'Link to a heading by the id GitHub gives it (`#foo_bar`), which differs from its own id (`#foobar`)',
  'link/missing-anchor': 'Link to an `#anchor` that does not exist',
  'link/missing-file': 'Link to a relative file that does not exist',
  'link/undefined-reference': 'Reference link with no `[label]: …` definition',
  'figure/duplicate-id': 'Two `:::figure` blocks share an `{#id}`; references go to the first',
  'figure/unknown-ref': '`:ref[id]` names no `:::figure` or other block in this document',
  'ref/unknown': 'An id attribute (`verifies`, `applies-to`) names an id no block of this document gives',
  'ref/ambiguous': 'An id attribute or `:ref[id]` names an id two or more blocks give, so it names none of them',
  'depends/cycle': 'A `depends-on` (or task `:depends`) or `supersedes` chain returns to its start',
  'decision/depends-superseded': 'An accepted decision depends on a superseded decision',
  'requirement/id': 'A `:::requirement` has no `{#id}`; the fix adds the next free id in the document\'s pattern',
  'requirement/uncovered': 'An accepted, implemented or verified requirement that no `:::acceptance` block verifies',
  'acceptance/id': 'A `:::acceptance` block has no `{#id}`; the fix adds the next free id in the document\'s pattern',
  'acceptance/verifies': 'A `:::acceptance` block has no `verifies` and sits in no requirement',
  'acceptance/verifies-type': '`verifies` names a block that isn\'t a requirement',
  'constraint/scope': 'A section-scoped `:::constraint` above the first heading, which applies to the whole document',
  'constraint/size': 'Document-scoped constraints together cost more than 500 tokens, which every section read pays',
  'assumption/overdue': 'An unvalidated `:::assumption` whose `review-by` date has passed',
  'assumption/invalid': 'An accepted requirement or decision `depends-on` an invalid assumption',
  'evidence/target': 'A `:::evidence` block with neither `supports` nor `contradicts`',
  'evidence/rev': 'A `:::evidence` block without `rev`, so a later change to what it supports can\'t be detected',
  'question/unanswered': 'A question says `answered` or `incorporated` but no answer exists, so it reads as open',
  'question/reason': 'A question is `withdrawn` without a `reason`',
  'question/overdue': 'An open question whose `due` date has passed',
  'decision/supersedes': 'A decision is superseded by another, but its status isn\'t `superseded`',
  'evidence/stale': 'A block an `:::evidence` record supports changed after the revision its `rev` records, so the record needs a recheck before it counts as current',
  'requirement/verified': 'A requirement says `status=verified` and no current passing evidence supports it (`result=pass`, a method other than acceptance, not outdated)',
  'progress/basis': 'A `:progress` value without a `basis` that says how it was found (`measured`, `estimate`)',
  'progress/basis-value': 'A `:progress{basis=tasks}` also has a `value`, which is ignored',
  'footnote/undefined': 'Footnote reference `[^label]` with no `[^label]: …` definition (info when the document defines no footnotes)',
  'footnote/unused': 'Footnote definition that nothing references (it is not shown)',
  'footnote/duplicate': 'Second definition of a footnote label (the first one is used)',
  'glossary/entry': 'List item in a `:::glossary` that is not `**Term**: definition`, or has no definition',
  'glossary/duplicate': 'A `:::glossary` term is defined again; its uses link to the first definition',
  'glossary/duplicate-id': 'The id of a `:::glossary` term (`term-…`) is also the id of a heading or another element',
  'glossary/unused': 'A `:::glossary` term is never used in the text',
  'changelog/date': 'A `:::changelog` release heading has a date that is not YYYY-MM-DD',
  'changelog/order': 'A `:::changelog` lists a newer version below an older one (releases go newest first)',
  'changelog/duplicate': 'A `:::changelog` lists the same version twice',
  'quote/empty': 'A `:::quote` has no text',
  'quote/author': 'A `:::quote` has no `author`',
  'quote/cite': 'A `:::quote` `cite` is not an http(s) or relative URL; it is left out',
  'variable/undefined': '`{{name}}` names no front matter key; it is shown as written',
  'variable/not-text': '`{{name}}` names a front matter mapping or empty value, which has no text',
  'task/overdue': 'Open task past its `:due[…]` date',
  'review/for': 'A `:::comment` or `:::suggestion` without `for=`, so it names no block',
  'review/stale': 'An open comment or suggestion whose target changed since its `rev`',
  'review/rev': 'A `:::comment` or `:::suggestion` without `rev=`, so a later change to its target cannot be detected',
  'review/open': 'An open comment or suggestion (an error in a document with `status: approved`)',
  'review/transition': 'A resolved, accepted, rejected or withdrawn comment or suggestion without `by` and `on`',
  'table/pipe-in-code': 'A `|` inside a code span in a table row still splits the cell, as on GitHub; write `\\|`',
  'views/key': 'A task view in the front matter `views:` has a key it does not know',
  'views/section': 'A task view lists a section that names no heading',
  'views/query': 'A task view\'s `query` is not a valid selector',
  'views/value': 'A task view, or its `sections`, `mandatory`, `optional`, `budget`, `evidence` or `description`, has the wrong type or value',
  'rules/unknown': 'Suppression comment or rule setting names an unknown rule code',
};

/**
 * Codes Semantic Markdown 2.0 removed, with the code that reports their problems now and what changed. A rule setting
 * or suppression comment that names one is reported as `rules/unknown` with this explanation (a comment gets a fix
 * to the new code), rather than as a code that never existed.
 */
const REMOVED_CODES: Readonly<Record<string, { code: string; why: string }>> = {
  'figure/kind': { code: 'attrs/value', why: 'was merged into "attrs/value" in Semantic Markdown 2.0: an invalid kind on a ":::figure" is an "attrs/value" error' },
  'deprecated/agent-priority': {
    code: 'attrs/unknown', why: 'was removed in Semantic Markdown 2.0 with "priority" on ":::agent", which is now reported as "attrs/unknown"',
  },
};

/**
 * What became of a removed rule code, or of a category (`deprecated/*`) whose every code was removed: the code to
 * name instead and why. Undefined for any other pattern.
 */
export function removedRule(pattern: string): { code: string; why: string } | undefined {
  if (Object.hasOwn(REMOVED_CODES, pattern)) return REMOVED_CODES[pattern];
  if (!pattern.endsWith('/*') || isKnownRule(pattern)) return undefined;
  const removed = Object.keys(REMOVED_CODES).filter((c) => c.startsWith(pattern.slice(0, -1)));
  if (!removed.length) return undefined;
  const codes = [...new Set(removed.map((c) => REMOVED_CODES[c].code))];
  return { code: codes.join(', '), why: `names only codes removed in Semantic Markdown 2.0 (${removed.map((c) => `"${c}"`).join(', ')})` };
}

/** The `rules/unknown` message for a pattern that names no known code. */
function unknownRuleMessage(pattern: string, where: string): string {
  const removed = removedRule(pattern);
  if (removed) return `Rule "${pattern}"${where} ${removed.why}. Name "${removed.code}" instead.`;
  const hint = suggest(pattern, Object.keys(RULE_CODES));
  return `Unknown rule "${pattern}"${where}${hint ? ` — did you mean "${hint}"?` : '.'}`;
}

/** `off` removes a rule's diagnostics; a severity replaces the rule's own. */
export type RuleSetting = 'off' | Severity;

/**
 * Rule settings by code. A key may be an exact code (`link/missing-file`), a category (`link/*`) or
 * `*` for every rule; the most specific key wins.
 */
export type RuleSettings = Record<string, RuleSetting>;

const SETTINGS: readonly string[] = ['off', 'error', 'warning', 'info', 'hint'];

/** Does a rule key or suppression pattern (`code`, `category/*` or `*`) name at least one known code? */
export function isKnownRule(pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) return Object.keys(RULE_CODES).some((c) => c.startsWith(pattern.slice(0, -1)));
  return Object.hasOwn(RULE_CODES, pattern);
}

function matches(pattern: string, code: string): boolean {
  return pattern === '*' || pattern === code || (pattern.endsWith('/*') && code.startsWith(pattern.slice(0, -1)));
}

function settingFor(code: string, rules: RuleSettings): RuleSetting | undefined {
  if (Object.hasOwn(rules, code)) return rules[code];
  const category = `${code.split('/')[0]}/*`;
  if (Object.hasOwn(rules, category)) return rules[category];
  return Object.hasOwn(rules, '*') ? rules['*'] : undefined;
}

/** Apply rule settings: drop diagnostics whose rule is `off` and change the severity of the rest. */
export function applyRuleSettings(diagnostics: Diagnostic[], rules: RuleSettings): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of diagnostics) {
    const setting = settingFor(d.code, rules);
    if (setting === 'off') continue;
    out.push(setting ? { ...d, severity: setting } : d);
  }
  return out;
}

/**
 * Check a parsed config file (`smd.config.json` / `.smdrc`). Returns its rule settings and problems
 * such as unknown codes or settings, which callers report where the file is loaded.
 */
export function readRuleConfig(data: unknown): { rules: RuleSettings; problems: string[] } {
  const rules: RuleSettings = {};
  const problems: string[] = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { rules, problems: ['The config must be a JSON object.'] };
  const raw = (data as Record<string, unknown>).rules;
  if (raw === undefined) return { rules, problems };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { rules, problems: ['"rules" must be an object of rule code → setting.'] };
  for (const [key, value] of Object.entries(raw)) {
    if (!isKnownRule(key)) {
      problems.push(unknownRuleMessage(key, ''));
      continue;
    }
    if (typeof value !== 'string' || !SETTINGS.includes(value)) {
      problems.push(`Rule "${key}" must be one of: ${SETTINGS.join(', ')}.`);
      continue;
    }
    rules[key] = value as RuleSetting;
  }
  return { rules, problems };
}

// ---------------------------------------------------------------------------
// Inline suppression comments
// ---------------------------------------------------------------------------

const COMMENT = /<!--\s*smd-(disable-next-line|disable-line|disable|enable)\b([^>]*?)\s*-->/g;

/**
 * Honor suppression comments, outside code fences and inline code spans (a comment quoted as `code` is an example):
 * - `<!-- smd-disable-next-line [codes] -->` for the line below
 * - `<!-- smd-disable-line [codes] -->` for its own line
 * - `<!-- smd-disable [codes] -->` … `<!-- smd-enable [codes] -->` for a range of lines
 * Codes are separated by spaces or commas and may use `category/*`; no codes means every rule.
 * Unknown codes are reported as `rules/unknown`, with a fix when a close match exists.
 */
export function applySuppressions(text: string, diagnostics: Diagnostic[], reportUnknown = true): Diagnostic[] {
  const lines = text.split(/\r?\n/);
  const suppressed = new Map<number, string[]>();
  const add = (line: number, patterns: string[]) => suppressed.set(line, [...(suppressed.get(line) ?? []), ...patterns]);
  const problems: Diagnostic[] = [];
  let open: string[] = [];
  let fence: { char: string; len: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (mark && mark[1][0] === fence.char && mark[1].length >= fence.len && !raw.slice(mark[0].length).trim()) fence = null;
      if (open.length) add(i, open);
      continue;
    }
    if (mark) fence = { char: mark[1][0], len: mark[1].length };
    let enabledHere: string[] | null = null;
    // Code spans are blanked to spaces of the same length, so columns still match `raw`.
    for (const m of maskCodeSpans(raw).matchAll(COMMENT)) {
      const patterns = m[2].split(/[\s,]+/).filter(Boolean);
      const start = m.index! + m[0].indexOf(m[2].trim() || '-->');
      for (const p of patterns) {
        if (isKnownRule(p)) continue;
        const col = raw.indexOf(p, start);
        const hint = removedRule(p)?.code ?? suggest(p, Object.keys(RULE_CODES));
        problems.push({
          line: i, column: col, endColumn: col + p.length, severity: 'warning', code: 'rules/unknown',
          message: unknownRuleMessage(p, ' in suppression comment'),
          ...(hint ? { fix: { line: i, column: col, endColumn: col + p.length, replacement: hint, title: `Change to "${hint}"` } } : {}),
        });
      }
      const list = patterns.length ? patterns : ['*'];
      if (m[1] === 'disable-next-line') add(i + 1, list);
      else if (m[1] === 'disable-line') add(i, list);
      else if (m[1] === 'disable') open = [...open, ...list];
      else {
        // smd-enable: re-enable the listed rules (or all) from the next line on.
        open = patterns.length ? open.filter((o) => !patterns.includes(o)) : [];
        enabledHere = open;
      }
    }
    if (open.length && enabledHere === null) add(i, open);
  }

  const kept = diagnostics.filter((d) => !(suppressed.get(d.line) ?? []).some((p) => matches(p, d.code)));
  if (!reportUnknown) return kept;
  return [...kept, ...problems.filter((d) => !(suppressed.get(d.line) ?? []).some((p) => matches(p, d.code)))];
}
