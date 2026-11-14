import { suggest } from './core/util';

/**
 * The options each `smd` command reads (improvement roadmap t-07, CL-05), and the argument parser that uses them.
 * An option a command doesn't read gets a did-you-mean warning on stderr, so JSON and other machine output stay
 * parseable, and the exit code stays what it was. Values are consumed as before: an option that takes a value for
 * any command takes it here too, so a script that passes, say, `--today` to a command that ignores it still runs.
 */

export interface Args { command?: string; positional: string[]; flags: Set<string>; values: Map<string, string[]> }

/** What a command reads: options that take no value, options that take one, and how it handles the rest. */
export interface CommandOptions {
  readonly flags?: readonly string[];
  readonly values?: readonly string[];
  /** Accept any option without a warning: editors start `smd lsp` with options of their own. */
  readonly open?: boolean;
  /** The command already refuses options it doesn't know, with its own message. */
  readonly checksOwn?: boolean;
}

const VIEW_FLAGS = ['--exact', '--brief', '--include-human', '--embed', '--no-includes', '--no-lines', '--constraints', '--views', '--inspect'];
const VIEW_VALUES = ['--max-tokens', '--tokenizer', '--section', '--provenance', '--view', '--today'];

/** Every command and the options it reads. Aliases (render, to-md, pdf, docx) have their own entries. */
export const COMMAND_OPTIONS: Readonly<Record<string, CommandOptions>> = {
  read: { flags: [...VIEW_FLAGS, '--outline', '--full', '--evidence'], values: [...VIEW_VALUES, '--follow', '--direction', '--depth'] },
  agent: { flags: [...VIEW_FLAGS, '--evidence'], values: VIEW_VALUES },
  savings: { flags: ['--json'], values: ['--price', '--today'] },
  outline: { flags: ['--related'], values: ['--tokenizer', '--today'] },
  tasks: { flags: ['--json', '--csv', '--gantt', '--smd', '--all'], values: ['--order', '--mine', '-o', '--title', '--today'] },
  risks: { flags: ['--all', '--html', '--json'], values: ['--status', '--owner', '-o'] },
  trace: { flags: ['--uncovered', '--json'], values: ['--today'] },
  query: { flags: ['--json', '--titles', '--brief', '--no-lines', '--constraints', '--contract'], values: ['--follow', '--direction', '--depth', '--provenance', '--today'] },
  rev: { flags: ['--json'] },
  updates: { flags: ['--json'], values: ['--since', '--today'] },
  diff: { flags: ['--json', '--brief', '--no-lines', '--exit-code'], values: ['--since', '--today'] },
  meta: { flags: ['--no-diagnostics'], values: ['--config', '--today', '--stale-after'] },
  decisions: { flags: ['--json', '--md'], values: ['--status', '--owner', '-o', '--title'] },
  report: { values: ['--since', '-o', '--today', '--title'] },
  issues: { flags: ['--apply', '--create', '--close', '--json'], values: ['--label', '--repo', '--today'] },
  index: { flags: ['--compact'], values: ['-o', '--today'] },
  validate: { flags: ['--json', '--strict', '--no-mermaid', '--fix'], values: ['--format', '--summary', '--config', '--today', '--stale-after'] },
  fmt: { flags: ['--check', '--stdout'] },
  merge: { flags: ['--install', '--uninstall'], values: ['--dir', '--command'] },
  review: { flags: ['--all', '--json'], values: ['--by', '--today', '--text', '--reason', '--kind', '--title'] },
  migrate: { flags: ['--dry-run', '--check', '--json', '--keep-typography', '--link-domains', '--quote-variables', '--no-verify'], values: ['--to'], checksOwn: true },
  build: { flags: ['--md', '--clean', '--comments'], values: ['--lang', '--url', '--out', '--title', '--base', '--image', '--today'] },
  export: {
    flags: ['--comments', '--help', '-h', '--landscape', '--html-only'],
    values: ['--to', '-o', '--lang', '--format', '--browser', '--reference-doc', '--pandoc', '--engine'],
  },
  render: { flags: ['--comments'], values: ['--lang', '-o'] },
  'to-md': { flags: ['--comments'], values: ['-o'] },
  pdf: { flags: ['--comments', '--landscape'], values: ['-o', '--lang', '--format', '--browser'] },
  docx: { flags: ['--comments', '--html-only'], values: ['-o', '--lang', '--reference-doc', '--pandoc', '--engine'] },
  'from-md': { values: ['--from', '-o', '--today'] },
  init: { flags: ['--no-mcp'], values: ['--template', '--title', '--today', '--agent', '--dir'] },
  templates: {},
  mcp: { flags: ['--allow-write', '--allow-suggest', '--legacy-tools'], values: ['--root'] },
  lsp: { flags: ['--stdio'], open: true },
  skills: { flags: ['--global'], values: ['--target', '--only', '--dir'] },
};

/** Options that take a value for some command: the parser consumes their value for every command, as it always has. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(Object.values(COMMAND_OPTIONS).flatMap((o) => o.values ?? []));

/** Whether a token reads as an option rather than a value: `-x` or `--name`, not `-1` or `-`. */
const looksLikeOption = (token: string): boolean => /^--?[A-Za-z]/.test(token);

/**
 * Parse `smd <command> …`. `--name=value` works for options that take a value. `--` ends the options, so the rest
 * are files even when they start with `-` (the pre-commit hook relies on it). Each problem the parser notices is
 * passed to `warn`; none changes the exit code.
 */
export function parseArgs(argv: readonly string[], warn: (message: string) => void = () => undefined): Args {
  const [command, ...rest] = argv;
  const args: Args = { command, positional: [], flags: new Set(), values: new Map() };
  const addValue = (name: string, value: string) => args.values.set(name, [...(args.values.get(name) ?? []), value]);
  const known = command === undefined ? undefined : COMMAND_OPTIONS[command];
  const reads = new Set([...(known?.flags ?? []), ...(known?.values ?? [])]);
  const unknown: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--') {
      args.positional.push(...rest.slice(i + 1));
      break;
    }
    if (!looksLikeOption(token)) {
      args.positional.push(token);
      continue;
    }
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (VALUE_OPTIONS.has(name)) {
      if (eq > 0) {
        addValue(name, token.slice(eq + 1));
      } else if (i + 1 < rest.length && !looksLikeOption(rest[i + 1]) && rest[i + 1] !== '--') {
        addValue(name, rest[++i]);
      } else {
        // A value option followed by another option, or by nothing, gets an empty value and leaves the next one alone.
        // The command reports the empty value in its own words (--to needs a format, --provenance needs a file).
        addValue(name, '');
      }
    } else {
      if (eq > 0 && reads.has(name)) warn(`${name} takes no value; ignored "${token.slice(eq + 1)}".`);
      args.flags.add(name);
    }
    if (!reads.has(name)) unknown.push(name);
  }
  if (known && !known.open && !known.checksOwn) {
    for (const name of new Set(unknown)) {
      const guess = suggest(name, [...reads]);
      warn(`Unknown option ${name} for smd ${command}${guess ? ` (did you mean ${guess}?)` : ''}; it is ignored.`);
    }
  }
  return args;
}

/** Whether a command reads an option, for checks that only some commands make (`--stale-after`). */
export const reads = (command: string | undefined, option: string): boolean =>
  command !== undefined && [...(COMMAND_OPTIONS[command]?.flags ?? []), ...(COMMAND_OPTIONS[command]?.values ?? [])].includes(option);
