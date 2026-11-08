import * as fs from 'node:fs';
import * as path from 'node:path';
import { feedbackUpdates, formatFeedbackUpdates, revisionOfText, UPDATES_NOTE } from './core';
import { git, gitPath } from './workspace';

/**
 * `smd updates <file> --since <checkpoint> [--json]`: the feedback state that changed since a checkpoint (AF22, AC-E).
 * A checkpoint is a Git commit, tag or branch, or `rev:<revision>` from an earlier read, found in the file's history.
 * Git runs without a shell. Nothing is written or stored.
 */

export interface UpdatesFlags { json?: boolean; today?: string }
export interface UpdatesOutput { code: number; stdout: string; stderr: string }

/** How many commits of the file's history a `rev:` checkpoint is looked for in. */
export const REV_SEARCH_LIMIT = 200;

const USAGE = 'Usage: smd updates <file.smd> --since <commit|tag|branch|rev:<revision>> [--json]';

export function runUpdates(file: string | undefined, since: string | undefined, flags: UpdatesFlags = {}): UpdatesOutput {
  const fail = (message: string): UpdatesOutput => ({ code: 2, stdout: '', stderr: `${message}\n` });
  if (!file) return fail(USAGE);
  if (!since || since.startsWith('-')) return fail(`${USAGE}\nGive the checkpoint with --since, e.g. --since HEAD~1 or --since rev:3f2a9c1b0d4e.`);
  if (!fs.existsSync(file)) return fail(`No such file: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(path.resolve(file));
  const top = git(['-C', dir, 'rev-parse', '--show-toplevel'])?.trim();
  const rel = top ? gitPath(top, file) : undefined;
  const show = (ref: string) => (top && rel ? git(['-C', top, 'show', `${ref}:${rel}`]) : undefined);

  const found = checkpoint(since, text, top, rel, show);
  if ('problem' in found) {
    return fail(`Unknown checkpoint "${since}": ${found.problem}. To recover, read the document in full (smd read ${file} --full), `
      + 'or pass a Git commit, tag or branch with --since <ref>.');
  }

  const revision = revisionOfText(text);
  const head = top ? git(['-C', top, 'rev-parse', '--short', 'HEAD'])?.trim() : undefined;
  const headText = head ? show('HEAD') : undefined;
  const next = { revision, ...(head && headText !== undefined && sameText(headText, text) ? { commit: head } : {}) };
  const updates = feedbackUpdates(found.text, text, { file: rel ?? file, today: flags.today });
  if (flags.json) {
    const out = {
      file, since: { checkpoint: since, ...(found.commit ? { commit: found.commit } : {}), revision: updates.revision.before },
      changes: updates.changes, otherChangedLines: updates.otherChangedLines, revision: updates.revision.after, next, note: UPDATES_NOTE,
    };
    return { code: 0, stdout: JSON.stringify(out, null, 2) + '\n', stderr: '' };
  }
  return { code: 0, stdout: formatFeedbackUpdates(updates, { since: found.label, next, file }), stderr: '' };
}

type Found = { text: string; label: string; commit?: string } | { problem: string };

function checkpoint(since: string, text: string, top: string | undefined, rel: string | undefined, show: (ref: string) => string | undefined): Found {
  const rev = /^rev:([0-9a-f]+)$/i.exec(since.trim());
  if (rev) {
    const want = rev[1].toLowerCase();
    if (want.length !== 12) return { problem: 'a revision is 12 hex digits, as smd read and the provenance manifest give it' };
    if (revisions(text).includes(want)) return { text, label: `${since} (the current text)` };
    if (!top || !rel) return { problem: 'no version of the file has this revision, and the file is not in a Git repository to search' };
    const log = git(['-C', top, 'log', '--format=%H', '-n', String(REV_SEARCH_LIMIT), '--', rel]) ?? '';
    for (const commit of log.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const old = show(commit);
      if (old !== undefined && revisions(old).includes(want)) return { text: old, label: `${since} (commit ${commit.slice(0, 7)})`, commit };
    }
    return { problem: `no version of the file in its last ${REV_SEARCH_LIMIT} commits, nor the current text, has this revision` };
  }
  if (!top || !rel) return { problem: 'the file is not in a Git repository' };
  const commit = git(['-C', top, 'rev-parse', '--verify', '--quiet', `${since}^{commit}`])?.trim();
  if (!commit) return { problem: 'Git knows no such commit, tag or branch' };
  const old = show(commit);
  if (old === undefined) return { problem: `the file did not exist at ${commit.slice(0, 7)}` };
  return { text: old, label: `${since} (${commit.slice(0, 7)})`, commit };
}

/** A text's revision with its line endings as written, and as LF and CRLF, since Git may convert them on checkout. */
function revisions(text: string): string[] {
  const lf = text.replace(/\r\n/g, '\n');
  return [...new Set([text, lf, lf.replace(/\n/g, '\r\n')])].map(revisionOfText);
}

const sameText = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
