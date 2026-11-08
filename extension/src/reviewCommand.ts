import * as fs from 'node:fs';
import {
  acceptSuggestion, addComment, addSuggestion, answerQuestion, incorporateQuestion, normalizeActor, rebaseItem, rejectSuggestion, reopenItem,
  resolveComment, reviewItems, targetText, withdrawItem, type ReviewItem, type ReviewResult,
} from './core/review';
import { fail } from './cliIo';
import { collect, read } from './workspace';

/**
 * `smd review`: list a document's open comments and suggestions, and make each review transition as its own command
 * (feedback loop RFC, "Commands"). Every transition takes `--by`, records `on` as today, and changes no other line.
 * A refused write exits 1 with the reason; a usage error exits 2.
 */

export interface ReviewArgs { positional: string[]; flags: Set<string>; values: Map<string, string[]> }

export const REVIEW_HELP = `  smd review <files|dirs...> [--all] [--json]
      The open comments and suggestions (:::comment, :::suggestion) with their targets and whether each is
      stale (its target changed since it was written). --all lists closed ones and answers too.
  smd review comment <file> <id> --text "…" --by @name [--title "…"] [--kind correction]
  smd review suggest <file> <id> --text "…" --by @name [--title "…"]
      Add a comment, or a suggested replacement for the body, after the block with that id, with its revision.
  smd review answer <file> <question-id> --text "…" --by @name
      Add a kind=answer comment after the question and set the question to answered.
  smd review incorporate <file> <question-id> --by @name
  smd review accept|reject|resolve|reopen|rebase <file> <item> --by @name [--reason "…"]
  smd review withdraw <file> <item> --by @name --reason "…"
      <item> is a comment's or suggestion's {#id}, or the 1-based line of its opening fence (withdraw and reopen
      also take a question). accept replaces the target's body with the suggestion's and is refused when the
      target changed since (stale): rebase shows the target's text now and records its revision, so a person
      re-accepts it explicitly. Each records by= and on= (today, or --today YYYY-MM-DD), keeps line endings and
      every other line, and never formats. A refusal exits 1 with the reason.
`;

const SUBCOMMANDS = new Set(['comment', 'suggest', 'answer', 'incorporate', 'accept', 'reject', 'withdraw', 'resolve', 'reopen', 'rebase']);

const value = (args: ReviewArgs, name: string) => args.values.get(name)?.[0];

export function runReview(args: ReviewArgs): number {
  const [first, ...rest] = args.positional;
  if (first && SUBCOMMANDS.has(first) && rest.length) return transition(first, rest, args);
  if (!args.positional.length) return fail(`smd review needs a file.\n\n${REVIEW_HELP}`);
  return list(args);
}

interface Listed extends Omit<ReviewItem, 'line' | 'endLine'> { file: string; line: number; endLine: number }

function list(args: ReviewArgs): number {
  const files = args.positional.flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const all = args.flags.has('--all');
  const rows: Listed[] = [];
  for (const file of files) {
    for (const item of reviewItems(read(file))) {
      if (!all && (!item.open || item.answer)) continue;
      rows.push({ ...item, file, line: item.line + 1, endLine: item.endLine + 1 });
    }
  }
  if (args.flags.has('--json')) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  if (!rows.length) {
    console.log(all ? 'No comments or suggestions.' : 'No open comments or suggestions.');
    return 0;
  }
  for (const r of rows) console.log(listLine(r));
  return 0;
}

function listLine(r: Listed): string {
  const kind = r.type === 'comment' ? (r.answer ? 'answer' : `comment (${r.kind})`) : 'suggestion';
  const facts = [r.attrs.author, r.attrs.date].filter(Boolean).join(', ');
  const state = r.open ? '' : ` [${r.status}${r.attrs.by ? ` by ${r.attrs.by}` : ''}${r.attrs.on ? ` on ${r.attrs.on}` : ''}]`;
  const target = r.for ? ` for ${r.for}${targetNote(r)}` : ' (no target)';
  return `${r.file}:${r.line}: ${kind}${r.id ? ` #${r.id}` : ''}${target}${facts ? `, ${facts}` : ''}${state}${r.title ? ` — ${r.title}` : ''}`;
}

function targetNote(r: Listed): string {
  if (r.target === 'missing') return ' (no such block)';
  if (r.target === 'ambiguous') return ' (ambiguous id)';
  if (r.stale) return ' [stale]';
  if (r.stale === null && r.open) return ' (no rev)';
  return '';
}

function transition(command: string, rest: string[], args: ReviewArgs): number {
  const [file, ref] = rest;
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(file ? `Not found: ${file}` : 'Missing file argument.');
  if (!ref) return fail(`smd review ${command} needs ${command === 'comment' || command === 'suggest' ? 'the target block\'s id' : 'an item: its {#id} or the line it opens on'}.`);
  const by = normalizeActor(value(args, '--by'));
  if (!by) return fail(`smd review ${command} needs --by @name: every transition records who made it.`);
  const today = value(args, '--today');
  if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) return fail('--today needs a date, YYYY-MM-DD.');
  const actor = { by, today };
  const text = read(file);
  const body = value(args, '--text');
  const needsText = command === 'comment' || command === 'suggest' || command === 'answer';
  if (needsText && !body?.trim()) return fail(`smd review ${command} needs --text "…".`);
  const reason = value(args, '--reason');
  let result: ReviewResult;
  switch (command) {
    case 'comment': {
      const kind = value(args, '--kind');
      if (kind !== undefined && !['remark', 'correction'].includes(kind)) return fail('--kind is remark or correction (an answer is smd review answer).');
      result = addComment(text, ref, { ...actor, text: body!, title: value(args, '--title'), kind });
      break;
    }
    case 'suggest': result = addSuggestion(text, ref, { ...actor, text: body!, title: value(args, '--title') }); break;
    case 'answer': result = answerQuestion(text, ref, { ...actor, text: body!, title: value(args, '--title') }); break;
    case 'incorporate': result = incorporateQuestion(text, ref, actor); break;
    case 'accept': result = acceptSuggestion(text, ref, actor); break;
    case 'reject': result = rejectSuggestion(text, ref, { ...actor, reason }); break;
    case 'withdraw':
      if (!reason?.trim()) return fail('smd review withdraw needs --reason "…".');
      result = withdrawItem(text, ref, { ...actor, reason });
      break;
    case 'resolve': result = resolveComment(text, ref, actor); break;
    case 'reopen': result = reopenItem(text, ref, actor); break;
    default: result = rebase(text, ref, actor); break;
  }
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  fs.writeFileSync(file, result.text);
  console.log(`${file}:${result.line + 1}: ${result.message}`);
  return 0;
}

/** Rebase, after printing the target's text now, so the person sees what they re-accept. */
function rebase(text: string, ref: string, actor: { by: string; today?: string }): ReviewResult {
  const result = rebaseItem(text, ref, actor);
  if (!result.ok) return result;
  // A rebase changes only the item's opening line, so it opens where it did.
  const item = reviewItems(text).find((r) => r.line === result.line);
  const current = item && targetText(text, item);
  if (item && current !== undefined) {
    console.log(`${item.for} now (rev ${item.currentRev}):`);
    console.log(current.split('\n').map((l) => `  ${l}`).join('\n'));
    console.log('');
  }
  return result;
}
