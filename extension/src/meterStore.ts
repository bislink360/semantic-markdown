import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseMeterLines, type MeterEvent } from './core';
import { eventFiles, meterSettings, type MeterSettings } from './meter/log';
import { findMeterRoot } from './meterCommand';

/**
 * The meter log of one workspace, in memory: every event file read once, then only the bytes appended since, as the
 * CLI, the MCP server and agent hooks write them. No second store: a month of heavy use is a few megabytes of text.
 */
export class MeterStore implements vscode.Disposable {
  private events: MeterEvent[] = [];
  /** Bytes of each event file already read (whole lines only). */
  private readonly offsets = new Map<string, number>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private watcher: vscode.FileSystemWatcher | undefined;
  private configWatcher: vscode.FileSystemWatcher | undefined;
  private current: MeterSettings;

  constructor(readonly root: string) {
    this.current = meterSettings(root);
    this.reload();
    this.watch();
    // Turning metering on or off (smd meter on, the card, an edited .smdrc) is picked up without a reload.
    this.configWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '{.smdrc,.smdrc.json,smd.config.json}'));
    const refresh = () => { this.current = meterSettings(root); this.watch(); this.reload(); };
    this.configWatcher.onDidChange(refresh);
    this.configWatcher.onDidCreate(refresh);
    this.configWatcher.onDidDelete(refresh);
  }

  get settings(): MeterSettings {
    return this.current;
  }

  get all(): readonly MeterEvent[] {
    return this.events;
  }

  /** The file's path relative to the workspace root, with `/`, as events name it; undefined outside the root. */
  relative(file: string): string | undefined {
    const rel = path.relative(this.root, file);
    return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join('/');
  }

  /** Read every event file again from the start. */
  reload(): void {
    this.events = [];
    this.offsets.clear();
    for (const file of eventFiles(this.current.dir)) this.tail(file, false);
    this.emitter.fire();
  }

  private watch(): void {
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.current.dir), 'events-*.jsonl'));
    const changed = (uri: vscode.Uri) => this.tail(uri.fsPath, true);
    this.watcher.onDidChange(changed);
    this.watcher.onDidCreate(changed);
    this.watcher.onDidDelete(() => this.reload());
  }

  /** Read what was appended to one file since the last read. A file that shrank was cleared: read everything again. */
  private tail(file: string, fire: boolean): void {
    let size: number;
    try { size = fs.statSync(file).size; } catch { return; }
    const from = this.offsets.get(file) ?? 0;
    if (size < from) { this.reload(); return; }
    if (size === from) return;
    const buffer = Buffer.alloc(size - from);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buffer, 0, buffer.length, from);
    } catch {
      return;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    // Only whole lines: a line being written is read on the next change.
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return;
    this.events.push(...parseMeterLines(buffer.subarray(0, end + 1).toString('utf8')));
    this.offsets.set(file, from + end + 1);
    if (fire) this.emitter.fire();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.configWatcher?.dispose();
    this.emitter.dispose();
  }
}

/** One store per workspace root, made on first use. */
export class MeterStores implements vscode.Disposable {
  private readonly stores = new Map<string, MeterStore>();
  private readonly emitter = new vscode.EventEmitter<MeterStore>();
  readonly onDidChange = this.emitter.event;

  /** The store of the workspace a document is in, or undefined for a file outside every workspace folder. */
  forUri(uri: vscode.Uri): MeterStore | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? this.forRoot(findMeterRoot(folder.uri.fsPath)) : undefined;
  }

  /** The store of the first workspace folder, for the panel when no .smd file is active. */
  first(): MeterStore | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? this.forRoot(findMeterRoot(folder.uri.fsPath)) : undefined;
  }

  forRoot(root: string): MeterStore {
    let store = this.stores.get(root);
    if (!store) {
      store = new MeterStore(root);
      const made = store;
      store.onDidChange(() => this.emitter.fire(made));
      this.stores.set(root, store);
    }
    return store;
  }

  dispose(): void {
    for (const s of this.stores.values()) s.dispose();
    this.emitter.dispose();
  }
}
