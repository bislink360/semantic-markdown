import * as fs from 'node:fs';
import { languageTag } from './core/i18n';

/** Small helpers every `smd` command shares: output to -o or stdout, usage errors and options. */

/** Write `content` to `target` (and say so on stderr), or to stdout without one. */
export function write(target: string | undefined, content: string): number {
  if (target) {
    fs.writeFileSync(target, content);
    console.error(`Wrote ${target}`);
  } else {
    process.stdout.write(content);
  }
  return 0;
}

/** A usage error: the message on stderr, exit code 2. */
export function fail(message: string): number {
  console.error(message);
  return 2;
}

/** A mistake in how a command was called: the CLI's error boundary prints its message alone and exits 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** The file argument; a usage error when it is missing, doesn't exist or isn't a file. */
export function requireFile(file: string | undefined): string {
  if (!file) throw new UsageError('Missing file argument.');
  if (!fs.existsSync(file)) throw new UsageError(`Not found: ${file}`);
  if (!fs.statSync(file).isFile()) throw new UsageError(`Not a file: ${file}`);
  return file;
}

/** Exit codes, the same for every command (docs/reference/features.md, "Exit codes"). */
export const EXIT = { ok: 0, problems: 1, usage: 2 } as const;

/**
 * The exit code for an error that reached the top of the CLI, after printing it on one line: a usage error exits 2,
 * anything else exits 1. `SMD_DEBUG=1` also prints the stack.
 */
export function reportCrash(error: unknown, env: NodeJS.ProcessEnv = process.env): number {
  const first = (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0];
  const usage = error instanceof UsageError;
  console.error(usage ? first : `smd: ${first || 'unexpected error'}`);
  if (env.SMD_DEBUG && error instanceof Error && error.stack) console.error(error.stack);
  return usage ? EXIT.usage : EXIT.problems;
}

export const LANG_USAGE = '--lang needs a language tag such as de or pt-BR.';

/** The `--lang` value: undefined when not given, null when it is not a language tag. */
export function langOption(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  return languageTag(value) ?? null;
}
