/**
 * When the editor re-validates a document after an edit (improvement roadmap t-10, CL-07). Only Semantic Markdown
 * documents are scheduled, closing a document cancels its pending run, and a run that fires for a document closed
 * in the meantime does nothing, so a closed document never gets its diagnostics back.
 */

/** The parts of a `vscode.TextDocument` the schedule reads. */
export interface ScheduledDocument {
  readonly uri: { toString(): string };
  readonly languageId: string;
  readonly isClosed: boolean;
}

export interface ScheduleTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const NODE_TIMERS: ScheduleTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class DiagnosticSchedule<D extends ScheduledDocument> {
  private readonly pending = new Map<string, unknown>();

  constructor(
    private readonly run: (document: D) => void,
    private readonly delay = 300,
    private readonly timers: ScheduleTimers = NODE_TIMERS,
  ) {}

  /** Run once the edits pause for `delay` ms. Other languages are ignored. */
  schedule(document: D): void {
    if (document.languageId !== 'smd' || document.isClosed) return;
    const key = document.uri.toString();
    this.cancel(key);
    this.pending.set(key, this.timers.set(() => {
      this.pending.delete(key);
      if (!document.isClosed) this.run(document);
    }, this.delay));
  }

  /** The document closed: forget its pending run. */
  close(document: D): void {
    this.cancel(document.uri.toString());
  }

  /** How many runs are waiting, for tests. */
  get size(): number {
    return this.pending.size;
  }

  dispose(): void {
    for (const handle of this.pending.values()) this.timers.clear(handle);
    this.pending.clear();
  }

  private cancel(key: string): void {
    if (!this.pending.has(key)) return;
    this.timers.clear(this.pending.get(key));
    this.pending.delete(key);
  }
}
