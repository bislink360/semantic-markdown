import { shortTokens, type MeterReport } from './core';

/**
 * The token meter's status bar item: the active file's raw size against its agent view (what an agent reads without
 * and with smd), and with metering on, what agents actually read of it in the last days. Pure, so the text and the
 * hover card can be tested without VS Code; agentViewUi.ts puts them on the status bar.
 */

export interface TokenCounts {
  /** The raw .smd file, which is what an agent reads without smd. */
  raw: number;
  /** The whole agent view. */
  agent: number;
  /** The agent view with --brief. */
  brief: number;
}

/** What the log says about the active file, for the card. */
export interface MeasuredUse {
  /** "last 7 days". */
  period: string;
  /** The file's report (meterReport with `paths: [file]`). */
  report: MeterReport;
}

export interface TokenMeterInput extends TokenCounts {
  /** Whether metering is on for the workspace. Undefined: no workspace (an untitled or outside file). */
  metering?: boolean;
  measured?: MeasuredUse;
}

export interface TokenMeter {
  /** Status bar text, e.g. `$(hubot) 6.3k → 2.1k tok · 14 reads`. */
  text: string;
  /** The hover card, as Markdown with the few HTML styles VS Code allows in hovers. */
  tooltip: string;
  /** Commands the card's links run. The MarkdownString must trust exactly these. */
  commands: string[];
  /** What clicking the item runs: the meter panel with metering on, else the agent view. */
  command: string;
}

/** Size of each bar, in CSS pixels: thin, like the progress bars of VS Code's own status popovers. */
export const BAR_WIDTH = 240;
export const BAR_HEIGHT = 4;

/**
 * Bar colours. A hover's SVG image can't read theme variables, so these are fixed mid-tone colours that read on light
 * and dark themes, close to VS Code's chart colours.
 */
export const BAR_COLORS = {
  raw: '#f14c4c',
  agent: '#3794ff',
  brief: '#4ec9b0',
  saved: '#4ec9b0',
  warn: '#cca700',
} as const;
export type BarColor = keyof typeof BAR_COLORS;

/** Links in the card: icon, label, command, hover title. */
const VIEW_ACTIONS: [string, string, string, string][] = [
  ['eye', 'Agent view', 'smd.showAgentView', 'Open what an agent reads, beside the source'],
  ['zap', 'Brief', 'smd.showAgentViewBrief', 'Open the brief agent view'],
  ['list-filter', 'Left out', 'smd.showAgentViewOmissions', 'What the agent view leaves out, and why'],
  ['copy', 'Copy', 'smd.copyAgentView', 'Copy the agent view for a chat'],
];
const OPEN_METER: [string, string, string, string] = ['graph', 'Open meter', 'smd.openTokenMeter', 'Workspace KPIs, sections, graph and agents'];
const TURN_ON: [string, string, string, string] = ['record', 'Turn on metering', 'smd.meter.turnOn', 'Record what agents read through smd, on this machine only'];

/** 6312 → "6.3k", 980 → "980". */
export const shortCount = (n: number): string => shortTokens(n);

/** Share of `raw` that `part` saves, rounded; negative when `part` is larger. */
export function savedPercent(part: number, raw: number): number {
  return raw > 0 ? Math.round((1 - part / raw) * 100) : 0;
}

/** Filled width of a bar, in pixels: `value` of `max`, at least the bar's height so a tiny value still shows. */
export function barFill(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(BAR_WIDTH, Math.max(BAR_HEIGHT, Math.round((value / max) * BAR_WIDTH)));
}

/**
 * A thin bar, `value` of `max` filled, as a Markdown image of an inline SVG. Hover HTML can't size a span, but VS
 * Code's hover renderer allows `data:` images, so the bar is drawn instead of typed. `label` is the alt text.
 */
export function bar(value: number, max: number, color: BarColor, label: string): string {
  const fill = barFill(value, max);
  const rect = (width: number, paint: string) => `<rect width="${width}" height="${BAR_HEIGHT}" rx="${BAR_HEIGHT / 2}" ${paint}/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="${BAR_HEIGHT}" viewBox="0 0 ${BAR_WIDTH} ${BAR_HEIGHT}">`
    + rect(BAR_WIDTH, 'fill="#808080" fill-opacity="0.25"')
    + (fill ? rect(fill, `fill="${BAR_COLORS[color]}"`) : '')
    + '</svg>';
  return `![${label.replaceAll(/[[\]]/g, '')}](data:image/svg+xml;base64,${btoa(svg)})`;
}

/** The share saved as a bar: filled to the percentage, or a full warning bar when smd sent more than the file. */
export function savingsBar(percent: number): string {
  return percent >= 0
    ? bar(Math.min(percent, 100), 100, 'saved', `${percent}% saved`)
    : bar(100, 100, 'warn', `${-percent}% more`);
}

const thousands = (n: number) => n.toLocaleString('en-US');
const link = ([icon, label, command, title]: [string, string, string, string]) => `[$(${icon}) ${label}](command:${command} "${title}")`;

function savings(part: number, raw: number): string {
  const pct = savedPercent(part, raw);
  if (pct > 0) return ` · **${pct}%** fewer`;
  if (pct < 0) return ` · ${-pct}% more (includes)`;
  return '';
}

/** The measured block of the card: session net savings, reads per agent, the most-read sections. */
function measuredBlock(m: MeasuredUse): string[] {
  const { kpis, clients, sections } = m.report;
  if (!m.report.events) return [`**Measured** · ${m.period}`, 'No agent reads of this file yet. Reads through the smd MCP server or CLI show up here.'];
  const net = kpis.sessionNet;
  const headline = net.baseline
    ? net.saved >= 0
      ? `**Measured** · ${m.period} · **${net.percent}%** saved (session net)`
      : `**Measured** · ${m.period} · <span style="color:var(--vscode-editorWarning-foreground);">used ${-net.percent}% more than reading the file once</span>`
    : `**Measured** · ${m.period}`;
  const lines = [
    headline + (net.baseline ? `  \n${savingsBar(net.percent)}` : ''),
    `${kpis.sessions} session${kpis.sessions === 1 ? '' : 's'} · ${kpis.reads} read${kpis.reads === 1 ? '' : 's'} · ≈${thousands(kpis.served)} tok served`
      + (net.baseline ? ` · ${shortTokens(net.baseline)} → ${shortTokens(net.served)}` : ''),
  ];
  const agents = clients.filter((c) => c.smdReads || c.rawReads).map((c) => `${c.name} ${c.smdReads}`).join(' · ');
  if (agents) lines.push(`Agents &nbsp; ${agents}`);
  const bypass = clients.filter((c) => c.share !== null && c.rawReads).map((c) => `${c.name} ${c.rawReads} raw read${c.rawReads === 1 ? '' : 's'}`);
  const unmeasured = clients.some((c) => c.share === null && c.smdReads) ? 'others n/m' : '';
  if (bypass.length || unmeasured) lines.push(`Bypassed smd &nbsp; ${[...bypass, unmeasured].filter(Boolean).join(' · ')}`);
  if (sections.length) lines.push(`Most read &nbsp; ${sections.slice(0, 3).map((s) => `${s.slug} ${s.reads}`).join(' · ')}`);
  return lines;
}

export function tokenMeter(input: TokenMeterInput): TokenMeter {
  const { raw, agent, brief, metering, measured } = input;
  const max = Math.max(raw, agent, brief);
  const pct = savedPercent(agent, raw);
  const row = (label: string, value: number, color: BarColor, note = '') =>
    `${label} &nbsp; **≈${thousands(value)}** tok${note}  \n${bar(value, max, color, `${thousands(value)} tokens`)}`;
  const estimate = [
    row('Without smd · raw file', raw, 'raw'),
    row('With smd · agent view', agent, 'agent', savings(agent, raw)),
    row('With smd · brief view', brief, 'brief', savings(brief, raw)),
  ];
  const actions = metering ? [OPEN_METER, ...VIEW_ACTIONS] : VIEW_ACTIONS;
  const parts = ['**$(hubot) Agent token meter**'];
  if (metering && measured) {
    parts.push(...measuredBlock(measured), '---', '**Estimate for this file**', ...estimate.slice(0, 2));
  } else {
    const headline = pct > 0 ? `### ${pct}% fewer tokens with smd` : pct < 0 ? `### ${-pct}% more tokens with smd` : '### Same tokens with smd';
    parts.push(`${headline}\n\n${savingsBar(pct)}`, '---', ...estimate);
  }
  parts.push('---', actions.map(link).join(' &nbsp;·&nbsp; '));
  if (metering === false) parts.push('---', `Measure real agent reads? &nbsp; ${link(TURN_ON)}`);
  const method = metering && measured ? 'Session net savings count each file once per session.' : 'Reading only the sections a task needs (`smd read`, then `--section`) saves more.';
  parts.push(`_Estimates at ≈4 characters per token. ${method}_`);
  const reads = metering && measured ? ` · ${measured.report.kpis.reads} read${measured.report.kpis.reads === 1 ? '' : 's'}` : '';
  return {
    text: `$(hubot) ${shortCount(raw)} → ${shortCount(agent)} tok${reads}`,
    tooltip: parts.join('\n\n'),
    commands: [...actions, ...(metering === false ? [TURN_ON] : [])].map(([, , command]) => command),
    command: metering ? 'smd.openTokenMeter' : 'smd.showAgentView',
  };
}
