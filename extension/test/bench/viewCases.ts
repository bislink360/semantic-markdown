import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentView, outline, sectionCosts, type AgentViewOptions, type AgentViewResult, type SectionCost } from '../../src/core/agentView';
import { readDocument, type ReadOptions, type ReadResult } from '../../src/readView';
import { composite, includeComposite } from './profile';

/**
 * Views whose output must not change when the view code is made faster: the samples, the profiler's composites and a
 * few documents made for the budget path's edge cases, each read with several options and many `maxTokens` budgets.
 * test/viewOutput.test.ts compares each case's digest with test/viewOutput.digests.json, written from the code before
 * the change (`node --import tsx test/bench/viewCases.ts --write`).
 */

export interface ViewApi {
  agentView: (text: string, options?: AgentViewOptions) => AgentViewResult;
  outline: (text: string, options?: AgentViewOptions) => string;
  sectionCosts: (text: string, options?: AgentViewOptions) => SectionCost[];
  readDocument: (text: string, options?: ReadOptions) => ReadResult;
}

export interface ViewCase { name: string; run: (api: ViewApi) => unknown }

const samplesDir = path.join(__dirname, '..', 'samples');

/** Counts words: a tokenizer whose counts don't follow from the length, so the budget counts the whole text. */
const words = { name: 'words', count: (text: string) => text.split(/\s+/).filter(Boolean).length };

/** Documents for the budget path's edge cases. */
const EDGE_DOCS: Record<string, string> = {
  // A front matter value with line breaks: the header shows them, and `{{desc}}` in the text joins its lines.
  'multi-line variable': [
    '---', 'smd: 1', 'title: Variables', 'desc: |', '  first line', '  second line', '---', '',
    '## One', '', 'Text {{desc}} here.', '', ...Array.from({ length: 30 }, (_, i) => `Line ${i} of section one, with words.`), '',
    '## Two', '', ...Array.from({ length: 30 }, (_, i) => `Line ${i} of section two {{desc}}.`), '',
    '### Two inner', '', ...Array.from({ length: 20 }, (_, i) => `Inner ${i}.`), '',
  ].join('\n'),
  // Blank and whitespace-only lines at the ends of sections and of the body, and runs of blank lines.
  'blank runs': [
    '---', 'title: Blanks', '---', '', '', '',
    '## A', '', '', '', ...Array.from({ length: 25 }, (_, i) => `a${i} words words words words`), '', '', '',
    '## B', '', '```', '', '', '   ', '', '```', '', ...Array.from({ length: 25 }, (_, i) => `b${i} words words words words`), '', '',
    '## C', '', '', ...Array.from({ length: 25 }, (_, i) => `c${i} words words words words`), '', '', '', '',
  ].join('\n'),
  // A parent section without key content and a child with a warning: the parent is omitted before the child.
  'parent before child': [
    '---', 'title: Nesting', '---', '',
    '## Parent', '', ...Array.from({ length: 30 }, (_, i) => `Parent text ${i} with some words in it.`), '',
    '### Child', '', ':::warning Careful', 'Keep this.', ':::', '', ...Array.from({ length: 30 }, (_, i) => `Child text ${i} with words.`), '',
    '### Sibling', '', ...Array.from({ length: 30 }, (_, i) => `Sibling text ${i} with words.`), '',
    '## Last', '', ...Array.from({ length: 30 }, (_, i) => `Last text ${i}.`), '',
  ].join('\n'),
  // GitHub alerts close after their last line that isn't blank, so view lines are not in source-line order.
  'alerts': [
    '---', 'title: Alerts', '---', '',
    '## First', '', '> [!WARNING]', '> Careful here.', '>', '> More.', '>', '', ...Array.from({ length: 30 }, (_, i) => `First ${i} words words.`), '',
    '## Second', '', '> [!NOTE]', '> A note.', '>', ...Array.from({ length: 30 }, (_, i) => `Second ${i} words words.`), '',
    '### Deeper', '', '> [!TIP]', '> Tip.', '', ...Array.from({ length: 30 }, (_, i) => `Deeper ${i} words.`), '',
  ].join('\n'),
  // Nothing but whitespace in the body once its sections are omitted.
  'only sections': [
    '---', 'title: Only sections', '---',
    '## S1', ...Array.from({ length: 40 }, (_, i) => `s1 ${i} words words words`),
    '## S2', ...Array.from({ length: 40 }, (_, i) => `s2 ${i} words words words`),
  ].join('\n'),
};

interface CaseDoc { name: string; text: string; dir: string }

/** Budgets: fixed ones, and `steps` fractions of the document's size. */
function budgets(full: number, steps: number): number[] {
  const set = new Set([0, 1, 50, 100, 300, 1000, 2000, 4000, 8000, full - 1, full, full + 1]);
  for (let k = 1; k <= steps; k++) set.add(Math.round((full * k) / steps));
  return [...set].filter((n) => n >= 0).sort((a, b) => a - b);
}

/** The cases, and a function that removes the include composite's temporary folder. */
export function viewCases(): { cases: ViewCase[]; cleanup: () => void } {
  const reader = (dir: string) => (rel: string) => {
    try {
      return fs.readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      return undefined;
    }
  };
  const docs: CaseDoc[] = fs.readdirSync(samplesDir).filter((f) => f.endsWith('.smd')).sort()
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(samplesDir, f), 'utf8'), dir: samplesDir }));
  for (const target of [8000, 20000, 50000]) docs.push({ name: `composite ≈${target / 1000}k`, text: composite(target), dir: samplesDir });
  const included = includeComposite(8000);
  docs.push({ ...included, name: 'composite with includes' });
  const edgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-view-cases-'));
  for (const [name, text] of Object.entries(EDGE_DOCS)) docs.push({ name, text, dir: edgeDir });

  const cases: ViewCase[] = [];
  for (const doc of docs) {
    const base: AgentViewOptions = { today: '2026-11-01', readFile: reader(doc.dir), file: 'doc.smd' };
    const add = (label: string, runs: Array<(api: ViewApi) => unknown>) => cases.push({ name: `${doc.name} · ${label}`, run: (api) => runs.map((r) => r(api)) });
    // The full view's size and a section to ask for come from the text, not from the code under test.
    const estimate = Math.ceil(doc.text.length / 4);
    const section = /^##\s+(.+?)\s*$/m.exec(doc.text.replace(/^```[\s\S]*?^```/gm, ''))?.[1] ?? 'x';
    const view = (options: AgentViewOptions) => (api: ViewApi) => api.agentView(doc.text, { ...base, ...options });
    add('views', [{}, { brief: true }, { sections: [section] }, { embed: true }, { includes: false }, { lineRefs: false }].map(view));
    add('provenance', [view({ provenance: true })]);
    add('constraints', [view({ sections: [section], constraints: true })]);
    // The two large composites get fewer budgets, and no tokenizer or brief section costs, which count text per step.
    const large = doc.text.length > 60_000;
    const sweep = budgets(estimate, large ? 12 : 40);
    add('maxTokens', sweep.map((maxTokens) => view({ maxTokens })));
    add('maxTokens brief', sweep.map((maxTokens) => view({ maxTokens, brief: true })));
    if (!large) add('maxTokens tokenizer', sweep.map((maxTokens) => view({ maxTokens, tokenizer: words })));
    const few = budgets(estimate, 4);
    add('maxTokens section', few.map((maxTokens) => view({ maxTokens, sections: [section] })));
    add('maxTokens provenance', few.map((maxTokens) => view({ maxTokens, provenance: true })));
    add('maxTokens no includes', few.map((maxTokens) => view({ maxTokens, includes: false })));
    add('outline', [(api) => api.outline(doc.text, base)]);
    add('sectionCosts', [(api) => api.sectionCosts(doc.text, base), ...(large ? [] : [(api: ViewApi) => api.sectionCosts(doc.text, { ...base, brief: true })])]);
    add('read', (['auto', 'full', 'outline'] as const).map((mode) => (api: ViewApi) => api.readDocument(doc.text, { ...base, mode })));
  }
  return {
    cases,
    cleanup: () => {
      fs.rmSync(included.dir, { recursive: true, force: true });
      fs.rmSync(edgeDir, { recursive: true, force: true });
    },
  };
}

/** A case's output as a short digest: sha256 of its JSON. */
export const digest = (output: unknown): string => createHash('sha256').update(JSON.stringify(output)).digest('hex').slice(0, 24);

export const DIGESTS = path.join(__dirname, '..', 'viewOutput.digests.json');

/** Writes the digests of `api`'s output for every case. */
export function writeDigests(api: ViewApi): number {
  const { cases, cleanup } = viewCases();
  try {
    const out: Record<string, string> = {};
    for (const c of cases) {
      if (out[c.name]) throw new Error(`Two cases are named ${c.name}`);
      out[c.name] = digest(c.run(api));
    }
    fs.writeFileSync(DIGESTS, JSON.stringify(out, null, 1) + '\n');
    return cases.length;
  } finally {
    cleanup();
  }
}

if (require.main === module && process.argv.includes('--write')) {
  const n = writeDigests({ agentView, outline, sectionCosts, readDocument });
  process.stdout.write(`Wrote ${n} digests to ${DIGESTS}\n`);
}
