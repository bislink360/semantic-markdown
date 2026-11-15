import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentView, renderSmd, validateSmd } from '../../../src/core';
import { readerFor } from '../../../src/workspace';
import { edited, includeComposite, type ProfileDoc } from '../profile';
import { defineScenario, type InProcessCase } from '../runner';

/**
 * Reading a document whose includes nest two deep and include the same file twice (profile.ts includeComposite, about
 * 8k tokens): validation, rendering and the agent view, with the CLI's file reader. The reads it counts are the
 * included files, read again on every call today (CL-14).
 */

interface State { doc: ProfileDoc; text: string }

function includeCase(name: string, run: (text: string, file: string) => unknown): InProcessCase<State> {
  return {
    name,
    setup: () => {
      const doc = includeComposite(8000);
      return { doc, text: doc.text };
    },
    teardown: (s) => fs.rmSync(s.doc.dir, { recursive: true, force: true }),
    edit: (s, n) => { s.text = edited(s.doc.text, n); },
    run: (s) => run(s.text, path.join(s.doc.dir, 'root.smd')),
  };
}

export default defineScenario({
  name: 'include-reads',
  description: 'Validate, render and read a document with nested and repeated includes, counting the included files read.',
  tasks: ['t-19', 't-21'],
  cases: [
    includeCase('validate', (text, file) => validateSmd(text, { readFile: readerFor(file), fileExists: () => true, today: '2026-11-01' })),
    includeCase('render', (text, file) => renderSmd(text, { readFile: readerFor(file), today: '2026-11-01' })),
    includeCase('agent view', (text, file) => agentView(text, { readFile: readerFor(file), file, today: '2026-11-01' })),
  ],
});
