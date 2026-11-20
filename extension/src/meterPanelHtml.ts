import { escapeHtml } from './core/attrs';
import { methodLabel, shortTokens, type MeterReport, type SectionGraph } from './core';

/**
 * The token meter panel's body: Overview, Sections, Graph and Agents tabs over one period. Pure HTML from the report,
 * so it can be tested without VS Code; meterPanel.ts loads it in a webview with media/token-meter.js, which switches
 * tabs and sends the clicks (period, file, open a section, copy the graph) back as messages.
 */

export type MeterTab = 'overview' | 'sections' | 'graph' | 'agents';
export const METER_TABS: readonly MeterTab[] = ['overview', 'sections', 'graph', 'agents'];
export type MeterPeriod = '7' | '30' | 'all';

export interface MeterPanelModel {
  root: string;
  enabled: boolean;
  /** Why it is off: `config` (not turned on) or `env` (SMD_METER=off). */
  off?: 'config' | 'env';
  /** The log reached its size cap. */
  paused?: boolean;
  period: MeterPeriod;
  tab: MeterTab;
  /** The workspace report for the period. */
  report: MeterReport;
  /** The file the Sections and Graph tabs show, and the files to choose from (most read first). */
  file?: string;
  files: string[];
  /** That file's report and section graph. */
  fileReport?: MeterReport;
  graph?: SectionGraph;
  /** That file's headings, so sections never read are listed too. `skip`: marked {agent=skip}. */
  headings?: Array<{ slug: string; text: string; level: number; skip: boolean }>;
}

const e = escapeHtml;
const n = (x: number) => x.toLocaleString('en-US');
const PERIODS: Array<[MeterPeriod, string]> = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'All recorded']];
const TAB_LABELS: Record<MeterTab, string> = { overview: 'Overview', sections: 'Sections', graph: 'Graph', agents: 'Agents' };

/** A small inline bar, `value` of `max`, in a theme colour. */
function meterBar(value: number, max: number, color = 'var(--vscode-progressBar-background)'): string {
  const width = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((Math.max(0, value) / max) * 100)) : 0;
  return `<span class="bar"><span style="width:${width}%;background:${color}"></span></span>`;
}

function card(title: string, value: string, note: string, warn = false): string {
  return `<div class="kpi${warn ? ' warn' : ''}"><div class="kpi-title">${e(title)}</div><div class="kpi-value">${value}</div><div class="kpi-note">${note}</div></div>`;
}

function offBody(model: MeterPanelModel): string {
  const env = model.off === 'env';
  return `<section class="empty">
<h2>Token metering is off</h2>
<p>${env ? 'The environment variable <code>SMD_METER=off</code> turns it off for VS Code.' : 'Turn it on to record which .smd files and sections agents read through smd, and how many tokens they received.'}</p>
<p>Events are written to <code>.smd/meter/</code> in this workspace, which is ignored by Git. Nothing leaves your machine and no document text is stored. You can turn it off or clear it at any time.</p>
${env ? '' : '<p><button data-msg="turnOn">Turn on metering</button></p>'}
<p class="muted">Agents outside VS Code pick it up from <code>"meter": true</code> in <code>.smdrc</code>, or run <code>smd meter on</code>.</p>
</section>`;
}

function overview(model: MeterPanelModel): string {
  const { kpis, files, tokenizers } = model.report;
  if (!model.report.events) {
    return `<section class="empty"><h2>No agent reads yet</h2>
<p>Agents that read .smd files through the smd MCP server or CLI show up here. Set one up with <code>smd init --agent claude</code> (or cursor, copilot).</p>
<p class="muted">Add <code>--meter</code> for Claude Code to also count its own reads of .smd files.</p></section>`;
  }
  const net = kpis.sessionNet;
  const share = kpis.smdShare === null ? 'n/m' : `${kpis.smdShare}%`;
  const measured = model.report.clients.filter((c) => c.share !== null).map((c) => c.name).join(', ');
  const cards = [
    card('Session net savings', `${shortTokens(net.saved)} <small>(${net.percent}%)</small>`, `vs ${shortTokens(net.baseline)} baseline`, net.saved < 0),
    card('Tokens served', shortTokens(kpis.served), `${n(kpis.reads)} reads · ${n(kpis.sessions)} sessions`),
    card('smd share', share, measured ? `measured for ${e(measured)}` : 'not measured: no raw-read hook'),
    card('Targeted reads', `${kpis.targeted.percent}%`, `outline, section, query · re-reads ${kpis.rereads.percent}%`),
  ].join('');
  const mixed = kpis.byTokenizer
    ? `<p class="note">This period mixes counting methods: ${Object.entries(kpis.byTokenizer).map(([t, s]) => `${e(t)} ${n(s.saved)} of ${n(s.baseline)} (${s.percent}%)`).join(' · ')}.</p>`
    : '';
  const max = Math.max(1, ...files.map((f) => f.baseline));
  const rows = files.map((f) => `<tr data-msg="file" data-file="${e(f.file)}" class="link">
<td>${e(f.file)}</td><td class="num">${n(f.reads)}</td><td class="num">${n(f.sessions)}</td><td class="num">${n(f.baseline)}</td><td class="num">${n(f.served)}</td>
<td class="num${f.saved < 0 ? ' neg' : ''}">${f.baseline ? `${f.percent}%` : '—'}</td><td>${meterBar(f.saved, max, f.saved < 0 ? 'var(--vscode-editorWarning-foreground)' : undefined)}</td></tr>`).join('\n');
  return `<div class="kpis">${cards}</div>${mixed}
<p class="muted">Per-read savings (overstates, counts the whole file on every read): ${n(kpis.perRead.saved)} (${kpis.perRead.percent}%). Content left out of whole-file views: ${n(kpis.withheld)}. Method: ${e(methodLabel(tokenizers))}.</p>
<table><thead><tr><th>File</th><th class="num">Reads</th><th class="num">Sessions</th><th class="num">Baseline</th><th class="num">Served</th><th class="num">Saved</th><th></th></tr></thead>
<tbody>${rows}</tbody></table>`;
}

function filePicker(model: MeterPanelModel): string {
  if (!model.files.length) return '';
  const options = model.files.map((f) => `<option value="${e(f)}"${f === model.file ? ' selected' : ''}>${e(f)}</option>`).join('');
  return `<label class="picker">File <select data-msg="file">${options}</select></label>`;
}

function sectionsTab(model: MeterPanelModel): string {
  if (!model.file || !model.fileReport) return '<p class="muted">No file has section reads in this period.</p>';
  const stats = new Map(model.fileReport.sections.map((s) => [s.slug, s]));
  const max = Math.max(1, ...model.fileReport.sections.map((s) => s.reads));
  const rows: string[] = [];
  const listed = new Set<string>();
  for (const h of model.headings ?? []) {
    listed.add(h.slug);
    const s = stats.get(h.slug);
    const indent = `style="padding-left:${(h.level - 2) * 14 + 6}px"`;
    const last = s ? s.lastRead.slice(0, 16).replace('T', ' ') : h.skip ? 'agent=skip' : 'never read';
    rows.push(`<tr data-msg="open" data-file="${e(model.file)}" data-slug="${e(h.slug)}" class="link${s ? '' : ' cold'}">
<td ${indent}>${e(h.text)}</td><td class="num">${s ? n(s.reads) : 0}</td><td class="num">${s ? n(s.sessions) : 0}</td><td class="num">${s ? n(s.served) : 0}</td>
<td class="num">${s && s.reads ? `${Math.round((s.rereads / s.reads) * 100)}%` : '—'}</td><td>${e(last)}</td><td>${meterBar(s?.reads ?? 0, max)}</td></tr>`);
  }
  const unmatched = model.fileReport.sections.filter((s) => !listed.has(s.slug));
  const extra = unmatched.length
    ? `<p class="muted">Unmatched (heading renamed or removed): ${unmatched.map((s) => `${e(s.slug)} ${s.reads}`).join(' · ')}</p>`
    : '';
  return `${filePicker(model)}
<table><thead><tr><th>Section</th><th class="num">Reads</th><th class="num">Sessions</th><th class="num">Served</th><th class="num">Re-reads</th><th>Last read</th><th></th></tr></thead>
<tbody>${rows.join('\n')}</tbody></table>${extra}`;
}

/** The graph as inline SVG: nodes on a circle sized by reads, co-reads solid, followed arrows, declared dashed. */
export function graphSvg(graph: SectionGraph, size = 520): string {
  const nodes = graph.nodes.slice(0, 24);
  if (!nodes.length) return '';
  const index = new Map(nodes.map((node, i) => [node.key, i]));
  const c = size / 2;
  const radius = nodes.length === 1 ? 0 : c - 70;
  const maxReads = Math.max(1, ...nodes.map((x) => x.reads));
  const pos = nodes.map((_, i) => {
    const a = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    return { x: c + radius * Math.cos(a), y: c + radius * Math.sin(a) };
  });
  const maxWeight = Math.max(1, ...graph.edges.map((x) => x.weight));
  const edges = graph.edges.flatMap((edge) => {
    const a = index.get(edge.a);
    const b = index.get(edge.b);
    if (a === undefined || b === undefined) return [];
    const p = pos[a];
    const q = pos[b];
    const w = 1 + (edge.weight / maxWeight) * 5;
    if (edge.kind === 'declared') return [`<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" class="e-declared"><title>${e(edge.type ?? 'declared')}</title></line>`];
    const cls = edge.kind === 'followed' ? 'e-followed' : 'e-coread';
    const marker = edge.kind === 'followed' ? ' marker-end="url(#arrow)"' : '';
    return [`<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" class="${cls}" style="stroke-width:${w.toFixed(1)}"${marker}><title>${edge.kind} ${edge.weight}</title></line>`];
  });
  const circles = nodes.map((node, i) => {
    const r = 8 + (node.reads / maxReads) * 16;
    const { x, y } = pos[i];
    const anchor = x < c - 5 ? 'end' : x > c + 5 ? 'start' : 'middle';
    const dx = anchor === 'end' ? -r - 4 : anchor === 'start' ? r + 4 : 0;
    const dy = anchor === 'middle' ? (y < c ? -r - 6 : r + 14) : 4;
    return `<g class="node" data-msg="open" data-file="${e(node.file)}" data-slug="${e(node.slug)}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"${node.reads ? '' : ' class="cold"'}><title>${e(node.slug)}: ${node.reads} reads</title></circle>`
      + `<text x="${(x + dx).toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}">${e(node.slug)} · ${node.reads}</text></g>`;
  });
  return `<svg viewBox="0 0 ${size} ${size}" width="100%" style="max-width:${size}px" role="img" aria-label="Section graph: ${nodes.length} sections">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker></defs>
${edges.join('\n')}
${circles.join('\n')}
</svg>`;
}

function graphTab(model: MeterPanelModel): string {
  const g = model.graph;
  if (!model.file || !g || !g.nodes.length) return `${filePicker(model)}<p class="muted">No section reads or declared links in this file for this period.</p>`;
  const name = (key: string) => e(key.slice(key.lastIndexOf('#') + 1));
  const never = g.findings.declaredNeverFollowed.map((x) => `<li>${name(x.a)} ↔ ${name(x.b)} <span class="muted">(${e(x.type ?? 'declared')})</span></li>`).join('');
  const together = g.findings.readTogetherNotLinked.map((x) => `<li>${name(x.a)} ↔ ${name(x.b)} <span class="muted">(${x.weight} sessions, add a :ref?)</span></li>`).join('');
  return `${filePicker(model)}
<p class="legend"><span class="k-coread"></span> read together (sessions) <span class="k-followed"></span> dependency followed <span class="k-declared"></span> declared link</p>
<div class="graph">${graphSvg(g)}</div>
<h3>Findings</h3>
<p><strong>Declared, never followed</strong></p>${never ? `<ul>${never}</ul>` : '<p class="muted">None.</p>'}
<p><strong>Read together, not linked</strong></p>${together ? `<ul>${together}</ul>` : '<p class="muted">None.</p>'}
<p><button data-msg="copyMermaid">Copy as Mermaid</button></p>`;
}

function agentsTab(model: MeterPanelModel): string {
  const rows = model.report.clients.map((c) => `<tr><td>${e(c.name)} <span class="muted">(${e(c.via.join(', '))})</span></td>
<td class="num">${n(c.sessions)}</td><td class="num">${n(c.smdReads)}</td><td class="num">${c.share === null ? 'n/m' : n(c.rawReads)}</td>
<td class="num">${c.share === null ? 'n/m' : `${c.share}%`}</td><td class="num">${n(c.served)}</td></tr>`).join('\n');
  if (!rows) return '<p class="muted">No agent reads in this period.</p>';
  return `<table><thead><tr><th>Agent</th><th class="num">Sessions</th><th class="num">smd reads</th><th class="num">Raw reads</th><th class="num">smd share</th><th class="num">Served</th></tr></thead>
<tbody>${rows}</tbody></table>
<p class="muted">n/m: not measured. Raw reads (an agent opening the .smd file with its own tool) are counted only where the agent reports them through a hook: <code>smd init --agent claude --meter</code> adds one for Claude Code.</p>`;
}

export function meterPanelBody(model: MeterPanelModel): string {
  const periods = PERIODS.map(([v, label]) => `<option value="${v}"${v === model.period ? ' selected' : ''}>${label}</option>`).join('');
  const header = `<header><h1>Token meter</h1><span class="muted">${e(model.root)}</span>
<span class="spacer"></span>${model.enabled ? `<label class="picker">Period <select data-msg="period">${periods}</select></label>
<span class="muted">${e(methodLabel(model.report.tokenizers))}</span> <button class="secondary" data-msg="clear" title="Delete every recorded event">Clear</button>` : ''}</header>`;
  if (!model.enabled) return header + offBody(model);
  const paused = model.paused ? '<p class="warnbar">Metering paused: the log reached its size cap. Clear old events or raise <code>meter.maxMegabytes</code> in .smdrc.</p>' : '';
  const tabs = METER_TABS.map((t) => `<button role="tab" class="tab${t === model.tab ? ' active' : ''}" data-tab="${t}" aria-selected="${t === model.tab}">${TAB_LABELS[t]}</button>`).join('');
  const panes: Record<MeterTab, string> = { overview: overview(model), sections: sectionsTab(model), graph: graphTab(model), agents: agentsTab(model) };
  const body = METER_TABS.map((t) => `<section class="pane" data-pane="${t}"${t === model.tab ? '' : ' hidden'}>${panes[t]}</section>`).join('\n');
  return `${header}${paused}<nav role="tablist">${tabs}</nav>\n${body}\n<p class="muted foot">Session net savings: each file's raw size once per agent session, against everything smd sent for it in that session. <a href="#" data-msg="howCounted">How this is counted</a></p>`;
}

export const METER_PANEL_CSS = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:0 16px 24px}
header{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--vscode-panel-border)}
h1{font-size:1.3em;margin:0}.spacer{flex:1}.muted{color:var(--vscode-descriptionForeground)}
nav{display:flex;gap:4px;margin:12px 0}
.tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--vscode-foreground);padding:6px 10px;cursor:pointer}
.tab.active{border-bottom-color:var(--vscode-focusBorder);font-weight:600}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:5px 12px;cursor:pointer;border-radius:2px}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:2px 4px}
.picker{display:inline-flex;gap:6px;align-items:center;margin:4px 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:8px 0}
.kpi{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:10px}
.kpi.warn .kpi-value{color:var(--vscode-editorWarning-foreground)}
.kpi-title{color:var(--vscode-descriptionForeground);font-size:.9em}.kpi-value{font-size:1.6em;font-weight:600;margin:4px 0}.kpi-note{color:var(--vscode-descriptionForeground);font-size:.85em}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--vscode-panel-border)}
.num{text-align:right;font-variant-numeric:tabular-nums}.neg{color:var(--vscode-editorWarning-foreground)}
tr.link{cursor:pointer}tr.link:hover{background:var(--vscode-list-hoverBackground)}tr.cold td{color:var(--vscode-descriptionForeground)}
.bar{display:inline-block;width:120px;height:8px;background:var(--vscode-editorWidget-border);border-radius:2px;overflow:hidden;vertical-align:middle}.bar>span{display:block;height:100%}
.empty{max-width:640px;margin:24px 0}.note,.warnbar{padding:6px 10px;border-left:3px solid var(--vscode-editorWarning-foreground)}
.graph svg text{fill:var(--vscode-foreground);font-size:11px}.graph circle{fill:var(--vscode-charts-blue);opacity:.85;cursor:pointer}.graph circle.cold{fill:var(--vscode-descriptionForeground);opacity:.5}
.e-coread{stroke:var(--vscode-charts-blue);opacity:.6}.e-followed{stroke:var(--vscode-charts-orange)}.e-declared{stroke:var(--vscode-descriptionForeground);stroke-dasharray:4 3;stroke-width:1}.arrow{fill:var(--vscode-charts-orange)}
.legend span{display:inline-block;width:18px;height:0;margin:0 4px 3px 10px;vertical-align:middle}
.k-coread{border-top:3px solid var(--vscode-charts-blue)}.k-followed{border-top:2px solid var(--vscode-charts-orange)}.k-declared{border-top:1px dashed var(--vscode-descriptionForeground)}
.foot{margin-top:16px}code{font-family:var(--vscode-editor-font-family)}
`;
