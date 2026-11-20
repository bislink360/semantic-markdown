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

/** Cells in each bar. */
const WIDTH = 24;

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

/**
 * A bar of `WIDTH` cells, `value` of `max` filled. Hovers allow only `color` and `background-color` styles, as hex or
 * `var(--vscode-…)`, in that order, so the bar is block characters coloured with theme variables.
 */
export function bar(value: number, max: number, fill: string): string {
  const filled = max > 0 ? Math.min(WIDTH, Math.max(value > 0 ? 1 : 0, Math.round((value / max) * WIDTH))) : 0;
  const cells = (n: number, color: string) => (n ? `<span style="color:var(${color});">${'█'.repeat(n)}</span>` : '');
  return cells(filled, fill) + cells(WIDTH - filled, '--vscode-editorWidget-border');
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
    headline,
    `${kpis.sessions} session${kpis.sessions === 1 ? '' : 's'} · ${kpis.reads} read${kpis.reads === 1 ? '' : 's'} · ≈${thousands(kpis.served)} tok served`
      + (net.baseline ? `  \n${bar(net.served, Math.max(net.baseline, net.served), '--vscode-progressBar-background')} &nbsp; ${shortTokens(net.baseline)} → ${shortTokens(net.served)}` : ''),
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
  const row = (label: string, value: number, fill: string, note = '') =>
    `${label} &nbsp; **≈${thousands(value)}** tok${note}  \n${bar(value, max, fill)}`;
  const estimate = [
    row('Without smd · raw file', raw, '--vscode-charts-red'),
    row('With smd · agent view', agent, '--vscode-progressBar-background', savings(agent, raw)),
    row('With smd · brief view', brief, '--vscode-charts-green', savings(brief, raw)),
  ];
  const actions = metering ? [OPEN_METER, ...VIEW_ACTIONS] : VIEW_ACTIONS;
  const parts = ['**$(hubot) Agent token meter**'];
  if (metering && measured) {
    parts.push(...measuredBlock(measured), '---', '**Estimate for this file**', ...estimate.slice(0, 2));
  } else {
    const headline = pct > 0 ? `### ${pct}% fewer tokens with smd` : pct < 0 ? `### ${-pct}% more tokens with smd` : '### Same tokens with smd';
    parts.push(headline, '---', ...estimate);
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
