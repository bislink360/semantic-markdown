import { changedIncludes, comparableHtml, COMPARE_TODAY, migrationPlan, type MigrationKind, type MigrationOptions, type MigrationPlan, type MigrationStep } from './migrate';
import { renderSmd } from './render';

export { comparableHtml } from './migrate';

/**
 * The check `smd migrate --to 2` runs on each file it writes (its `--verify`, on by default): the written document
 * has nothing left to migrate, and spec v2 renders it as v1 rendered the original. Pure, like the plan: files are
 * read only through `options.readFile`.
 *
 * Internal, as the plan is: not exported from the npm package.
 */

export interface MigrationCheck {
  /** Changes a new plan of the written document still makes (planned with `force`, as it says `smd: 2`): none expected. */
  left: MigrationStep[];
  /**
   * `same`: spec v2 renders the written document as v1 rendered the original. `explained`: it renders differently, and
   * the plan has notes or steps that keep the v2 meaning, which say where (typography left off, a value shown as
   * written, …). `differs`: it renders differently and nothing in the plan says why.
   */
  rendering: 'same' | 'explained' | 'differs';
  /** For `explained`: the kinds of the notes and v2-meaning steps, in the order the steps run. */
  explainedBy: MigrationKind[];
  /**
   * The included files (their `file=` as written, once each) whose text spec v2 shows differently in the written
   * document from how v1 showed it in the original: the including document's version decides how included text is
   * read (§3.4). The plan's `include-text` notes name them; without such a note the rendering `differs`.
   */
  includes: string[];
}

/** Each document rendered with the rules its own `smd` value selects: the original's v1, the written one's v2. */
const rendered = (text: string, options: MigrationOptions) => comparableHtml(renderSmd(text, { readFile: options.readFile, today: COMPARE_TODAY }).html);

/**
 * Check a written migration: `original` is the document before it, `written` the document as read back, and `plan`
 * the plan that was applied (with the same `options`).
 */
export function checkMigration(original: string, written: string, plan: MigrationPlan, options: MigrationOptions = {}): MigrationCheck {
  const left = migrationPlan(written, { ...options, force: true }).steps.filter((s) => !s.note);
  const includes = [...new Set(changedIncludes(original, written, options.readFile).map((i) => i.file))];
  if (rendered(written, options) === rendered(original, options)) return { left, rendering: 'same', explainedBy: [], includes };
  const unnamed = includes.length > 0 && !plan.steps.some((s) => s.kind === 'include-text' && s.note);
  const explainedBy = [...new Set(plan.steps.filter((s) => s.note || s.keeps === 'v2').map((s) => s.kind))];
  return { left, rendering: explainedBy.length && !unnamed ? 'explained' : 'differs', explainedBy, includes };
}
