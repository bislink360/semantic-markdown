// The study log writer: JSON lines in one local file, for one session. A new session id and a new salt for document
// ids each time a session starts; the salt is never written, so a logged id can't be turned back into a path, and
// nothing carries over to the next session. No `vscode` import, so the unit tests can check it.
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { sanitizeStudyEvent, STUDY_SCHEMA_VERSION, type StudyEvent, type StudyEventType } from './schema';

/** Where the lines go: appends one line (with its newline). */
export type StudySink = (line: string) => void;

export interface StudyLoggerOptions {
  /** The log file. Without it (and without `sink`) the logger is off and does nothing. */
  file?: string;
  /** Instead of a file (tests). */
  sink?: StudySink;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
  /** Random bytes for the session id and salt (tests). */
  random?: (size: number) => Buffer;
}

export interface StudyLogger {
  /** False for a logger that was never turned on: every method does nothing. */
  readonly enabled: boolean;
  /** This session's id: 16 hex digits, or '' when off. */
  readonly session: string;
  /** A document's id in this session: a salted hash of its URI, the same for the whole session. */
  docId(uri: string): string;
  /** Write an event; fields not in the schema are dropped. Returns what was written (undefined when off or unknown). */
  log(type: StudyEventType, fields?: Readonly<Record<string, unknown>>): StudyEvent | undefined;
  /** Milliseconds since the session started. */
  elapsed(): number;
  /** Stop: later calls do nothing. */
  close(): void;
}

/** A logger that records nothing: what every build gets until a study session is turned on. */
export const STUDY_LOGGER_OFF: StudyLogger = /* @__PURE__ */ Object.freeze({
  enabled: false,
  session: '',
  docId: () => '',
  log: () => undefined,
  elapsed: () => 0,
  close: () => undefined,
});

/** A file sink: creates the file (owner read and write only) and appends to it, each line written at once. */
export function fileSink(file: string): StudySink & { close(): void } {
  let fd: number | undefined = fs.openSync(file, 'a', 0o600);
  const write = (line: string) => {
    if (fd !== undefined) fs.writeSync(fd, line);
  };
  return Object.assign(write, {
    close() {
      if (fd !== undefined) fs.closeSync(fd);
      fd = undefined;
    },
  });
}

/** A logger for one session, or the off logger when there is nowhere to write. */
export function createStudyLogger(options: StudyLoggerOptions = {}): StudyLogger {
  const file = !options.sink && options.file ? fileSink(options.file) : undefined;
  const sink = options.sink ?? file;
  if (!sink) return STUDY_LOGGER_OFF;
  const now = options.now ?? Date.now;
  const random = options.random ?? randomBytes;
  const session = random(8).toString('hex');
  const salt = random(32);
  const started = now();
  let seq = 0;
  let open = true;
  const ids = new Map<string, string>();
  return {
    enabled: true,
    session,
    docId(uri) {
      let id = ids.get(uri);
      if (!id) {
        id = createHash('sha256').update(salt).update(uri, 'utf8').digest('hex').slice(0, 16);
        ids.set(uri, id);
      }
      return id;
    },
    log(type, fields = {}) {
      if (!open) return undefined;
      const clean = sanitizeStudyEvent(type, fields);
      if (!clean) return undefined;
      const at = now();
      const event: StudyEvent = { v: STUDY_SCHEMA_VERSION, session, seq: seq++, t: new Date(at).toISOString(), ms: at - started, type: clean.type, ...clean.fields };
      // Only the number of dropped fields: their names come from code, but the log needs no more than the count.
      if (clean.dropped.length) event.dropped = clean.dropped.length;
      sink(`${JSON.stringify(event)}\n`);
      return event;
    },
    elapsed: () => now() - started,
    close() {
      open = false;
      ids.clear();
      file?.close();
    },
  };
}

/**
 * Active time: time with the window focused and some activity (an edit, a scroll, a click in a view) in the last
 * `idle` milliseconds. Each activity counts the time since the one before, up to `idle`.
 */
export class ActiveClock {
  private total = 0;
  private last: number | undefined;

  constructor(private focused: boolean, start: number, private readonly idle = 60_000) {
    if (focused) this.last = start;
  }

  /** Some activity now. */
  touch(now: number): void {
    if (!this.focused) return;
    if (this.last !== undefined) this.total += Math.max(0, Math.min(now - this.last, this.idle));
    this.last = now;
  }

  /** The window gained or lost focus now. */
  setFocused(focused: boolean, now: number): void {
    if (focused === this.focused) return;
    if (!focused) this.touch(now);
    this.focused = focused;
    this.last = focused ? now : undefined;
  }

  /** Active milliseconds so far. */
  activeMs(now: number): number {
    const open = this.focused && this.last !== undefined ? Math.max(0, Math.min(now - this.last, this.idle)) : 0;
    return Math.round(this.total + open);
  }
}
