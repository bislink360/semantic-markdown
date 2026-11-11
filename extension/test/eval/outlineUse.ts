import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Whether agents use the outline's per-section token costs when they choose what to read (Study 1, "Outline cost
 * use"). The run already saves every transcript with each tool call's arguments and result, so this reads them back
 * and logs, for every episode of an `.smd` tool condition (S3 and its ablations), each outline the agent received,
 * each section it then asked for, what the outline said that section cost, and where that cost ranks among the
 * sections it could have chosen. It also notes whether the agent passed a token budget to the tool and whether its
 * own messages mention tokens or cost.
 *
 * It is descriptive. Agents choose sections for relevance, so a cheap pick is not evidence of using the costs, and a
 * comparison of the outline with and without costs is what would test it.
 */

/** One section row of an outline: `L18-32    ## Heading    ≈341  notes`. */
export interface OutlineEntry { heading: string; level: number; lines: [number, number]; cost: number }

/** One section the agent asked for after an outline. */
export interface SectionChoice {
  /** 0-based index of the tool call in the episode. */
  call: number;
  /** The section as the agent named it. */
  requested: string;
  /** The outline heading it matched, or null when it matched none or several. */
  heading: string | null;
  /** The cost the outline showed for it. */
  cost: number | null;
  /** How many sections of that outline cost less. */
  cheaper: number | null;
  /** The sections the outline listed. */
  of: number;
  /** `cheaper / (of - 1)`: 0 is the cheapest section, 1 the dearest; null with one section or no match. */
  percentile: number | null;
}

export interface OutlineUseEpisode {
  model: string;
  doc: string;
  task: string;
  condition: string;
  run: number;
  /** A `run-<n>.failed-<k>.json` transcript. */
  failed: boolean;
  file: string;
  /** Tool results that were an outline. */
  outlines: number;
  /** Sections asked for after the agent had seen an outline. */
  choices: SectionChoice[];
  /** Calls that asked for the whole view (`mode: full`). */
  fullReads: number;
  /** Calls that passed a `maxTokens` value. */
  budgetArgs: number;
  /** Whether any assistant message mentions tokens, cost or an `≈` count. */
  mentionsCost: boolean;
}

export interface OutlineUseSummary {
  model: string;
  condition: string;
  episodes: number;
  withOutline: number;
  choices: number;
  matched: number;
  /** Median percentile of the matched choices. */
  medianPercentile: number | null;
  /** Share of matched choices in the cheaper half of their outline (percentile at most 0.5). */
  cheaperHalf: number | null;
  /** Share of episodes whose messages mention tokens or cost. */
  mentionsCost: number | null;
  /** Share of episodes with at least one `maxTokens` argument. */
  budgetArgs: number | null;
}

export interface OutlineUseReport { episodes: OutlineUseEpisode[]; summary: OutlineUseSummary[]; problems: string[] }

const ROW = /^L(\d+)-(\d+)\s+(#{1,6}) (.+?)\s{2,}≈?([\d,]+)(?:\s{2,}\S.*)?$/;

/**
 * The section rows of an outline, or null when the text is not an outline. An outline ends its rows with the line
 * `Read a section: smd agent <file> --section …`, which no section read or whole view prints.
 */
export function parseOutline(text: string): OutlineEntry[] | null {
  if (!/(^|\n)Read a section: smd agent /.test(text)) return null;
  const rows: OutlineEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ROW.exec(line.trimEnd());
    if (m) rows.push({ lines: [Number(m[1]), Number(m[2])], level: m[3].length, heading: m[4].trim(), cost: Number(m[5].replace(/,/g, '')) });
  }
  return rows.length ? rows : null;
}

const norm = (s: string) => s.replace(/^#+\s*/, '').trim().toLowerCase();

/** The outline row a requested section names: an exact title first, then the only title that contains it. */
export function matchSection(entries: OutlineEntry[], requested: string, exact = false): OutlineEntry | null {
  const want = norm(requested);
  const same = entries.filter((e) => norm(e.heading) === want);
  if (same.length === 1) return same[0];
  if (same.length > 1 || exact) return null;
  const partial = entries.filter((e) => norm(e.heading).includes(want));
  return partial.length === 1 ? partial[0] : null;
}

const MENTIONS_COST = /\btokens?\b|\bcost(s|ly)?\b|≈\s?\d/i;

const contentOf = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('') : '';

/** True for the `.smd` tool conditions whose outline shows costs. */
export const isOutlineCondition = (condition: string) => condition === 'S3' || condition.startsWith('S3.');

/** The outline use of one transcript, or null when it is not an `.smd` tool condition. */
export function outlineUseOf(t: any, file: string): OutlineUseEpisode | null {
  const condition = String(t?.condition ?? '');
  if (!isOutlineCondition(condition)) return null;
  const calls: any[] = Array.isArray(t.toolCalls) ? t.toolCalls : [];
  let outline: OutlineEntry[] | null = null;
  let outlines = 0;
  let fullReads = 0;
  let budgetArgs = 0;
  const choices: SectionChoice[] = [];
  calls.forEach((call, i) => {
    const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
    if (typeof args.maxTokens === 'number') budgetArgs++;
    if (args.mode === 'full') fullReads++;
    const sections: unknown[] = Array.isArray(args.sections) ? args.sections : [];
    if (outline) {
      for (const s of sections) {
        if (typeof s !== 'string') continue;
        const hit = matchSection(outline, s, args.exact === true);
        const cheaper = hit ? outline.filter((e) => e.cost < hit.cost).length : null;
        choices.push({
          call: i, requested: s, heading: hit?.heading ?? null, cost: hit?.cost ?? null, cheaper, of: outline.length,
          percentile: hit && outline.length > 1 ? cheaper! / (outline.length - 1) : null,
        });
      }
    }
    const parsed = typeof call?.result === 'string' ? parseOutline(call.result) : null;
    if (parsed) { outline = parsed; outlines++; }
  });
  const messages: any[] = Array.isArray(t.messages) ? t.messages : [];
  const mentionsCost = messages.some((m) => m?.role === 'assistant' && MENTIONS_COST.test(contentOf(m.content)));
  return {
    model: String(t.model?.label ?? ''), doc: String(t.doc ?? ''), task: String(t.task ?? ''), condition, run: Number(t.run ?? 0),
    failed: /\.failed-\d+\.json$/.test(file), file, outlines, choices, fullReads, budgetArgs, mentionsCost,
  };
}

function transcriptFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? transcriptFiles(p) : e.name.endsWith('.json') ? [p] : [];
  }).sort((x, y) => x.localeCompare(y));
}

const share = (n: number, d: number) => (d ? n / d : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Outline use over a run folder's `transcripts/`, answered episodes only in the summary. */
export function outlineUse(runDir: string, options: { model?: string } = {}): OutlineUseReport {
  const problems: string[] = [];
  const episodes: OutlineUseEpisode[] = [];
  for (const file of transcriptFiles(path.join(runDir, 'transcripts'))) {
    let t: unknown;
    try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { problems.push(`${file}: not JSON (${(e as Error).message})`); continue; }
    const ep = outlineUseOf(t, path.relative(runDir, file).split(path.sep).join('/'));
    if (ep && (!options.model || ep.model === options.model)) episodes.push(ep);
  }
  if (!episodes.length) problems.push(`no S3 transcripts under ${path.join(runDir, 'transcripts')}`);
  const groups = new Map<string, OutlineUseEpisode[]>();
  for (const ep of episodes.filter((e) => !e.failed)) {
    const key = `${ep.model}\u0000${ep.condition}`;
    groups.set(key, [...(groups.get(key) ?? []), ep]);
  }
  const summary = [...groups.values()].map((eps): OutlineUseSummary => {
    const all = eps.flatMap((e) => e.choices);
    const matched = all.filter((c) => c.percentile !== null).map((c) => c.percentile!);
    return {
      model: eps[0].model, condition: eps[0].condition, episodes: eps.length, withOutline: eps.filter((e) => e.outlines > 0).length,
      choices: all.length, matched: matched.length, medianPercentile: median(matched),
      cheaperHalf: share(matched.filter((p) => p <= 0.5).length, matched.length),
      mentionsCost: share(eps.filter((e) => e.mentionsCost).length, eps.length),
      budgetArgs: share(eps.filter((e) => e.budgetArgs > 0).length, eps.length),
    };
  }).sort((a, b) => a.model.localeCompare(b.model) || a.condition.localeCompare(b.condition));
  return { episodes, summary, problems };
}

const pct = (x: number | null) => (x === null ? '-' : `${(100 * x).toFixed(1)}%`);
const num = (x: number | null) => (x === null ? '-' : x.toFixed(2));

export function outlineUseText(r: OutlineUseReport): string {
  const lines = [
    '# Outline cost use',
    '',
    'For each S3 episode: the sections the agent asked for after an outline, and where the cost the outline showed for each ranks among the sections it listed (percentile 0 is the cheapest, 1 the dearest). Agents pick sections for relevance, so this describes choices and does not test whether the costs were used. Answered episodes only.',
    '',
    '| model | condition | episodes | with outline | section reads | matched | median percentile | in cheaper half | mention tokens or cost | pass maxTokens |',
    '|-|-|-|-|-|-|-|-|-|-|',
    ...r.summary.map((s) => `| ${s.model} | ${s.condition} | ${s.episodes} | ${s.withOutline} | ${s.choices} | ${s.matched} | ${num(s.medianPercentile)} | ${pct(s.cheaperHalf)} | ${pct(s.mentionsCost)} | ${pct(s.budgetArgs)} |`),
  ];
  if (r.problems.length) lines.push('', '## Problems', '', ...r.problems.map((p) => `- ${p}`));
  return lines.join('\n') + '\n';
}
