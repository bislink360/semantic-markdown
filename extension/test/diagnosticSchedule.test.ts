import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticSchedule, type ScheduleTimers } from '../src/diagnosticSchedule';

/** Closed documents never get diagnostics back (improvement roadmap t-10, CL-07). */

interface Doc { uri: { toString(): string }; languageId: string; isClosed: boolean }
const doc = (name: string, languageId = 'smd'): Doc => ({ uri: { toString: () => `file:///${name}` }, languageId, isClosed: false });

/** Timers that fire only when the test says so. */
function manualTimers(): ScheduleTimers & { fire(): void; live: number } {
  const live = new Map<number, () => void>();
  let next = 1;
  return {
    set: (run) => { live.set(next, run); return next++; },
    clear: (handle) => { live.delete(handle as number); },
    fire() { const runs = [...live.values()]; live.clear(); runs.forEach((r) => r()); },
    get live() { return live.size; },
  };
}

test('t-10: only Semantic Markdown documents are scheduled, and a burst of edits runs once', () => {
  const timers = manualTimers();
  const ran: string[] = [];
  const schedule = new DiagnosticSchedule<Doc>((d) => ran.push(d.uri.toString()), 300, timers);
  const smd = doc('a.smd');
  schedule.schedule(doc('notes.md', 'markdown'));
  schedule.schedule(smd);
  schedule.schedule(smd);
  assert.equal(timers.live, 1);
  timers.fire();
  assert.deepEqual(ran, ['file:///a.smd']);
  assert.equal(schedule.size, 0);
});

test('t-10: closing a document clears and deletes its timer', () => {
  const timers = manualTimers();
  const ran: Doc[] = [];
  const schedule = new DiagnosticSchedule<Doc>((d) => ran.push(d), 300, timers);
  const a = doc('a.smd');
  const b = doc('b.smd');
  schedule.schedule(a);
  schedule.schedule(b);
  a.isClosed = true;
  schedule.close(a);
  assert.equal(timers.live, 1, 'the closed document has no timer left');
  assert.equal(schedule.size, 1);
  timers.fire();
  assert.deepEqual(ran, [b]);
});

test('t-10: a run that fires after the document closed does nothing, and a closed document is not scheduled', () => {
  const timers = manualTimers();
  const ran: Doc[] = [];
  const schedule = new DiagnosticSchedule<Doc>((d) => ran.push(d), 300, timers);
  const a = doc('a.smd');
  schedule.schedule(a);
  a.isClosed = true;
  timers.fire();
  schedule.schedule(a);
  assert.deepEqual(ran, []);
  assert.equal(timers.live, 0);
});

test('t-10: dispose clears every pending timer', () => {
  const timers = manualTimers();
  const schedule = new DiagnosticSchedule<Doc>(() => assert.fail('nothing runs after dispose'), 300, timers);
  schedule.schedule(doc('a.smd'));
  schedule.schedule(doc('b.smd'));
  schedule.dispose();
  assert.equal(timers.live, 0);
  assert.equal(schedule.size, 0);
});

test('t-10: the default timers wait for the delay', async () => {
  const ran: Doc[] = [];
  const schedule = new DiagnosticSchedule<Doc>((d) => ran.push(d), 5);
  const a = doc('a.smd');
  schedule.schedule(a);
  assert.deepEqual(ran, []);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(ran, [a]);
});
