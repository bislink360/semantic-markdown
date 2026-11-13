import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  agentView, applyFixes, DECISION_STATUS_FILTERS, decisionLog, decisionLogMarkdown, diffSmd, formatRelated, formatSmd, ganttDate,
  ganttDocument, getDocumentInfo, IMPORT_FORMATS, madrToSmd, markdownToSmd, outline, specKitTasksToSmd, relatedDocs, renderRiskPage, formatTrace, traceRequirements, traceSummary,
  RISK_STATUS, riskRegister, riskRegisterSummary, riskRegisterText, LATEST_SPEC, smdIndex,
  statusChanges, statusReportMarkdown, suggest, tasksToCsv, tasksToGantt, type AgentViewOptions, type AgentViewResult,
  type BudgetResult, type Diagnostic, type DiffResult, type Provenance, type ReportDocument, type Tokenizer,
} from './core';
import { incompleteLine } from './core/applicability';
import { MIGRATE_HELP, runMigrate } from './migrateCommand';
import { MERGE_HELP, runMerge } from './mergeCommand';
import { followOptions, runQuery, type QueryFlags } from './queryCommand';
import { REVIEW_HELP, runReview } from './reviewCommand';
import { runTaskView } from './taskViewCommand';
import { runUpdates } from './updatesCommand';
import { runRev } from './revCommand';
import { loadMermaidParser } from './mermaidLoader';
import { loadTokenizer, TokenizerError, TOKENIZERS } from './tokenizer';
import { EXPORT_HELP, runExport } from './exportCommand';
import { fail, langOption, LANG_USAGE, requireFile, write } from './cliIo';
import { loadRuleConfig, readConfigFile, type LoadedConfig } from './config';
import { runMcpServer } from './mcp';
import { readDocument, READ_BUDGET, type ReadMode, type ReadResult } from './readView';
import { MCP_SERVER_NAME, McpConfigError, mcpConfigFor, mergeMcpConfig, type McpConfigSpec } from './agentSetup';
import { runSavings } from './savings';
import { runLanguageServer } from './lsp';
import { runIssues, type GhResult, type IssuesOptions } from './issueSync';
import { runBuild } from './siteBuild';
import { isHttpUrl } from './core/siteMeta';
import { AGENT_RULES, fillTemplate, SKILLS, TEMPLATES } from './skillsBundle';
import {
  isGenerated, parseTargets, rulesBody, SHARED_CLI_COMMAND, SHARED_CLI_PATH, TARGET_FILES, type AgentTarget, type RulesTarget, type TargetFile,
} from './agentTargets';
import {
  collect, decisionLine, decisionSummary, deletedSince, diagnose, existsFrom, git, gitPath, graphReader, read, readerFor,
  reportSummary, taskLine, taskRows, taskSummary, workingPath, type TaskRow,
} from './workspace';
import {
  blobBase, githubAnnotations, validationSummary, type ConfigProblem, type FileReport, type ValidationResult,
} from './validateFormats';
// Injected by scripts/build.mjs. package.json itself stays out of the bundle, so editing its
// scripts or dependencies doesn't change the CLI's bytes (and the copies bundled in skills/).
declare const __SMD_PKG_VERSION__: string;
const pkg = { version: typeof __SMD_PKG_VERSION__ === 'string' ? __SMD_PKG_VERSION__ : '0.0.0-dev' };

const HELP = `smd — Semantic Markdown tool (spec v${LATEST_SPEC})

Reading (token-efficient, for agents):
  smd read <file.smd> [--max-tokens <n>] [--section "<heading>"]... [--exact] [--brief] [--outline | --full]
           [--no-lines] [--tokenizer <name>] [--constraints] [--provenance <file.json>]
           [--follow <types|*> [--direction out|in|both] [--depth 1-3]]
      Start here. The whole agent view when it fits n tokens (default ${READ_BUDGET}), else the outline,
      so one call replaces outline + agent. --section reads only those sections. --tokenizer counts
      the view with that encoding to decide. --constraints and --provenance as on agent.
      --follow       after the view, the edges of the content read, as on query: neighbors as pointers
                     with their cost, include, applies-to and depends-on targets in full, and what is
                     unsatisfied ("[incomplete: …]"). What the view shows isn't repeated, and it counts
                     toward n. Other files are read only in the document's folder, which --direction in
                     also searches. Not with --outline or --view; an outline follows nothing.
  smd savings <files|dirs...> [--json]
      Tokens an agent saves by reading the agent view instead of the raw files, per document and in
      total, as a number and a percentage.
  smd outline <file.smd> [--related] [--tokenizer <name>]
      Sections with line ranges and token costs, open tasks, where agent instructions are.
      --related    also list the front matter "related:" documents: title, status, summary and cost
  smd agent <file.smd> [--section "<heading>"]... [--exact] [--brief] [--include-human] [--embed] [--no-includes]
                       [--no-lines] [--max-tokens <n>] [--tokenizer <name>] [--constraints] [--provenance <file.json>]
                       [--evidence]
      Compact agent view: styling, layout and human-only content removed; meaning kept.
      --section    only these sections (repeatable; agent instructions elsewhere are still included)
      --exact      --section matches a heading's id or whole text only (by default a part of the text,
                   so "API" also selects "API details")
      --brief      also condense diagrams, long code, :::details and completed tasks
      --embed      inline file="…" code embeds instead of referencing the file
      --no-includes a one-line pointer for each :::include instead of the included text (by default
                   it is shown in an <included file="…"> block; line references in it are that file's)
      --max-tokens fit the view into n tokens: condense as --brief, then replace the least important
                   sections with one-line pointers (never the header, agent instructions or --section)
      --tokenizer  exact counts next to the ≈ estimate (also on outline, and used by --max-tokens) for an
                   OpenAI encoding: ${TOKENIZERS.join(', ')}. Approximate for Claude models.
                   Needs the js-tiktoken package in your project or installed globally; smd doesn't bundle it.
      --constraints with --section, also list the constraints elsewhere in the document (experimental):
                   :::danger blocks in full; warnings, accepted decisions and open questions as pointers
      --provenance write a JSON manifest of the view to a file: source hashes, settings, resolved
                   sections, a source map and every omission with its reason. The text doesn't change.
      --evidence   for review: after each requirement and acceptance criterion shown, the evidence that
                   supports or contradicts it in full (from any section), outdated records marked, and
                   "[evidence: none for R1]" for a requirement with none
  smd agent <file.smd> --view <name> [--inspect] [--section …] [--max-tokens <n>] [--brief] [--provenance <file.json>]
  smd agent <file.smd> --views
      A task view the author declared in the front matter (views:): its sections and query, its mandatory
      blocks in full with what they depend on, its optional blocks as pointers, within its budget. Flags
      on top are recorded as the agent's choice. --inspect explains the view for people instead of
      printing it. --views lists the views. smd read --view does the same.
  smd tasks <files|dirs...> [--all] [--mine @name] [--order priority|deps] [--json | --csv | --gantt [--smd] [--title "…"]]
            [-o <file>]
      Open tasks across documents with owner, priority and due date (overdue first).
      --order   deps lists each task after the tasks its :depends[…] names (T1, or plan.smd#T1 in a listed file), else the
                default priority order; tasks in a dependency cycle keep their order
      --csv     CSV for spreadsheets (1-based lines, owners joined with ";", formula-like cells prefixed with ')
      --gantt   Mermaid gantt chart: a section per document, a milestone per task with a due date
                (done tasks "done", overdue ones "crit"); --all includes done tasks. A task that
                :depends on charted tasks comes after them, as a bar from "after" them to its due date
      --smd     wrap the chart in a .smd document, e.g. smd tasks docs --gantt --smd -o timeline.smd
  smd risks <files|dirs...> [--status open,mitigated,accepted,closed] [--owner @name] [--all] [--json]
            [--html] [-o <file>]
      Risk register: every :::risk block, scored impact × likelihood (low 1, medium 2, high 3, critical 4;
      a missing level counts as medium and shows as "medium?"), highest score first, then a matrix of
      counts. Closed risks are left out unless --all or --status asks for them.
      --html  a standalone, theme-aware page: a colour-coded matrix that links to the register table
  smd trace <files|dirs...> [--uncovered] [--json]
      Each requirement in five separate columns: status as written, coverage (acceptance criteria that
      verify it), claims (tasks in it or that :depends on it, checked of total), evidence (verification
      records that support it: passing, failing, inconclusive, outdated) and human acceptance (evidence
      with method=acceptance). Then the counts, each of all requirements. A checked task is never
      evidence, and an acceptance criterion is never evidence. Evidence ids resolve in their own document.
      --uncovered  only requirements no acceptance criterion covers
  smd query "<selector>" <files|dirs...> [--json] [--titles] [--brief] [--no-lines] [--constraints]
            [--follow <types|*> [--direction out|in|both] [--depth 1-3]]
  smd query "<selector>" <files|dirs...> --contract [--json] [--brief] [--no-lines] [--provenance <file.json>]
      Blocks selected by type and attributes, each in the agent view. Exit code 1 when nothing matches.
        decision[status=accepted]      risk[impact>=high][status!=closed]      api[method=POST|PUT]
        task[owner=@maya][done=false]  task[due<today]    question, risk       heading[level=2]
        heading[title=Rollout] task    heading[level=2] > decision             risk:not([status=closed])
      Types: any container (decision, risk, api, note, question, agent…), callout, task, heading, * (any).
      Tests: [key] [key=a|b] [key!=v] [key*=v] [key^=v] [key$=v] [key<v] (also <= > >=: numbers, dates,
      priorities, risk levels); every block also has title, section and type. A space selects blocks
      inside headings and containers, > direct children, :not(…) leaves matches out.
      --titles       one line per match instead of its content
      --constraints  also the documents' :::agent blocks and document-wide :::constraint blocks
      --follow       neighbors along these edge types (link, ref, related, include, applies-to, depends-on,
                     verifies, supports, contradicts, supersedes, between, for), kinds (navigation,
                     mandatory, evidence, lifecycle, review) or *, as one-line pointers with their cost.
                     include, applies-to and depends-on targets come in full, with what they need in turn.
                     Other files are read only inside the paths given. --direction (default out) and
                     --depth (default 1) say which edges and how far.
      --contract     each document's matches as a section read carries them: an agent view of the
                     matched blocks under their headings, with the document's agent instructions and
                     dangers, the constraints that apply to the matches, the depends-on closure with
                     what it could not satisfy, and completeness (coverage, resolution, budget). Several
                     documents each follow a "==> file <==" line. --json: per document its matches,
                     view and mandatory context. --provenance writes one manifest per document, as an
                     array. Goes with neither --follow nor --titles.
  smd diff <old.smd> <new.smd> [--json] [--brief] [--no-lines] [--exit-code]
  smd diff <files|dirs...> --since <git-ref> [--json] [--brief] [--no-lines] [--exit-code]
      Only the sections that changed, in the agent view of the new version: front-matter changes,
      then changed, renamed and added sections, then removed ones (heading and old lines only).
      --since      compare each .smd file with its version at a Git commit, branch or tag
      --exit-code  exit 1 when something changed (like git diff); the default is 0
  smd updates <file.smd> --since <commit|tag|branch|rev:<revision>> [--json]
      What changed in the document's feedback since a checkpoint: questions answered or reopened,
      suggestions accepted or rejected, comments, tasks checked or reopened, and requirements,
      constraints, acceptance criteria, decisions, assumptions and evidence that changed, each with
      the blocks that point at it. Other changed lines are only counted. rev: is the revision an
      earlier read gave, looked for in the file's Git history. An unknown checkpoint exits with 2.
      Reading the updates records nothing: it is not incorporation.
  smd rev <file.smd> <id>… [--json]
      The current revision of each block, as id@revision, to record in rev= on a comment, a suggestion
      or an evidence record. A block's revision changes when its text changes, not its attributes.
  smd meta <file.smd> [--no-diagnostics]
      Full JSON summary: front matter, outline, tasks, decisions, risks, agent blocks.
  smd decisions <files|dirs...> [--status <list>] [--owner @name] [--json] [--md] [-o <file>] [--title "…"]
      Decision log (ADR index): every :::decision across documents, newest first and undated last, with
      date, status, title, owner, file:line and document › section.
      --status  only these statuses, comma-separated: ${DECISION_STATUS_FILTERS.join(', ')} (open = proposed)
      --owner   only decisions owned by @name
      --md      an ADR index to commit: front matter and a table linking each decision (--title sets its title).
                Links are relative to the -o file: smd decisions docs/ --md -o docs/decisions.smd
  smd report <files|dirs...> --since <date|git-ref> [-o report.smd] [--title "…"] [--today YYYY-MM-DD]
      Draft a status report (the status-report template) from how tasks and decisions changed since a Git
      commit, branch or tag, or a date (the last commit before it): done and new tasks, open tasks with
      overdue and due in the next 7 days, decisions since and still needed, open high-impact risks, and
      links to each source section. Tasks are matched by document and text, so a reworded task counts
      as removed and added. Without Git history, a date reports the current state only.
      -o        write the draft there (never over an existing file); links are relative to it
  smd index <files|dirs...> [-o catalog.json] [--compact]
      JSON catalog of every document: title, summary, status, owners, tags, token costs, sections
      and counts (open tasks, decisions, risks, questions, APIs). Agents read it to pick documents,
      then run outline or agent --section on them. Paths are relative to the working directory.
      --compact  one line of JSON instead of indented

Syncing with GitHub Issues (a dry run unless --apply):
  smd issues <files|dirs...> [--repo owner/name] [--apply] [--create] [--close] [--label <name>]... [--json]
      Sync tasks with GitHub Issues through your GitHub CLI (gh, logged in). Without --apply it only
      prints the plan and changes nothing: tasks to check off (their issue was closed), open tasks
      without an issue, and issues whose task is done. A task is linked by an issue reference on its
      line: [#123](https://github.com/owner/name/issues/123), the bare URL, or owner/name#123.
      --apply   sync: check off tasks whose issue was closed (not those closed as "not planned")
      --create  with --apply, also open an issue for each open task without one and add [#N](url) to it
      --close   with --apply, also close the issue of each done task
      --repo    repository for new issues (default: the current folder's, from gh repo view)
      --label   label for new issues (repeatable or comma-separated)

${MERGE_HELP}
Checking and converting:
  smd validate <files|dirs...> [--json] [--fix] [--strict] [--config <file>] [--no-mermaid] [--stale-after <days>]
      Check .smd files. Exit code 1 on errors (or warnings with --strict). --fix applies safe fixes.
      Rules are configured by the nearest smd.config.json or .smdrc (or --config):
        { "rules": { "link/missing-file": "off", "frontmatter/*": "hint", "task/overdue": "error" } }
      and silenced inline with <!-- smd-disable-next-line rule/code -->.
      Mermaid diagrams are parsed for syntax errors (--no-mermaid skips it).
      Documents whose "updated" date is over 180 days old are reported as stale (--stale-after 0: off).
  smd validate <files|dirs...> --format github [--summary <file>] [...]
      GitHub Actions annotations: one ::error/::warning/::notice workflow command per problem (hints are
      left out), with paths relative to $GITHUB_WORKSPACE (else the current folder). --format json = --json.
      --summary  also append a Markdown summary (counts and the first 50 problems) to a file, with any
                 format, e.g. --summary "$GITHUB_STEP_SUMMARY"
  smd fmt <files|dirs...> [--check] [--stdout]
      Format .smd files in place: container fences, attribute lists, tables and blank lines.
      --check   change nothing; list unformatted files and exit 1 if there are any
      --stdout  print the formatted file instead of writing it (one file)
      validate and fmt take any number of files: use them as a pre-commit hook (see docs/guides/install.md).
      After --, every argument is a file, even one that starts with "-".
${MIGRATE_HELP}${REVIEW_HELP}${EXPORT_HELP}
  smd build <dir> [--out site] [--title "…"] [--base /docs/] [--url https://…/] [--image <url|path>] [--md] [--clean] [--comments] [--today YYYY-MM-DD] [--lang <tag>]
      Static docs site: a page per .smd file in the same folders (links between documents rewritten,
      linked images copied), a sidebar, breadcrumbs, previous/next, backlinks, client-side search and
      a dashboard of open tasks, decisions and open risks. Opens from disk or any static web server.
      --out    the site folder (default: site): must be outside <dir>, and new, empty or a previous build
      --base   deployment path for absolute links, e.g. /docs/ (default: relative links)
      --url    the site's public address, e.g. https://example.com/docs/: canonical links, og:url and
               sitemap.xml (and robots.txt at the root of a host). Default: --base when it is a URL
      --image  the image link previews show (og:image): a URL, or a path under --url
               Every page gets a meta description (front matter "summary:") and Open Graph tags,
               and the site an llms.txt listing its documents for AI tools.
      --md     also publish .md files; the home page is <dir>/index.smd or README, else a generated index
      --clean  first delete the files of the previous build (only those listed in its .smd-site.json)
      --comments  keep review comments and suggestions on the pages (left out by default)
      --lang   language of the navigation, search and dashboard, and of documents without "lang:"
               (default: the home document's "lang:", else English)
  smd from-md <file.md> [-o out.smd]       Upgrade Markdown to .smd
  smd from-md <file.md> --from <madr|spec-kit> [-o out.smd] [--today YYYY-MM-DD]
      Import a file another tool wrote; every line of text is kept.
      madr      a MADR decision record (MADR 2 bullets, MADR 3/4 front matter): the decision becomes a
                :::decision with its status, date and decision makers (owner), around "Decision Outcome"
      spec-kit  a GitHub Spec Kit tasks.md: each T001 task gets {#T001}, and "(depends on T001, T002)"
                naming tasks of the file gets :depends[T001,T002]; [P] and story labels stay as written
      What is kept as text instead of mapped (an unknown status, an unclear dependency) is a warning
      on stderr. --today sets "updated:" when the file has no date.
  smd init <file.smd> [--template <name>] [--title "My doc"]
      New document from a template: ${Object.keys(TEMPLATES).join(', ')} (default: prd)
  smd templates                            List templates

Agent integration:
  smd init --agent <claude|cursor|copilot|agents>[,…] [--dir <project>] [--no-mcp]
      One-command setup for an agent in a project (default: the current folder). Installs the skills
      (claude) or the reading/writing rules (cursor, copilot, agents: AGENTS.md), this CLI, and the
      MCP server in the agent's config: .mcp.json (claude), .cursor/mcp.json, .vscode/mcp.json
      (copilot). Existing configs are merged; re-run to update.
  smd mcp [--root <dir>] [--allow-write] [--allow-suggest] [--legacy-tools]
      Model Context Protocol server over stdio with the tools read, tasks, query and validate. Only .smd
      files inside --root (default: the current directory) can be read.
      --allow-write   add check_task, set_status and add_decision (each refuses edits that add errors)
      --allow-suggest add suggest, which proposes new text for a block as a :::suggestion for a person
                      to accept or reject (smd review), and never edits content
      --legacy-tools  also list the older outline, section and agent tools (always callable)
      Register it, e.g.: claude mcp add smd -- npx -y -p semantic-markdown smd mcp

Editor integration:
  smd lsp [--stdio]
      Language server (LSP) over stdio for Neovim, Helix, Zed and other editors: diagnostics with quick
      fixes, outline, workspace symbols, hover, completion, go to definition and formatting. Also
      installed as smd-language-server by the npm package. Setup guides: docs/guides/editors.md

Agent skills:
  smd skills install [--dir <skills-dir>] [--global] [--only reader|writer]
      Install the agent skills (each with this CLI bundled) into .claude/skills (default),
      a custom directory, or ~/.claude/skills (--global):
        semantic-markdown-reader   read .smd token-efficiently
        semantic-markdown-writer   create/edit .smd following the rules
  smd skills install --target <claude|cursor|copilot|agents>[,…] [--dir <project>]
      Install for other agents too (repeatable or comma-separated; default: claude). Other targets write
      reading/writing rules into the project (--dir, default: current folder) and this CLI to .smd/smd.cjs:
        cursor    .cursor/rules/semantic-markdown.mdc (applies to **/*.smd)
        copilot   .github/instructions/semantic-markdown.instructions.md (applies to **/*.smd)
        agents    a semantic-markdown section in AGENTS.md (created, or replaced between its markers)
`;

const SKILLS_USAGE = 'Usage: smd skills install [--dir <dir>] [--global] [--only reader|writer] [--target claude|cursor|copilot|agents]';

interface Args { command?: string; positional: string[]; flags: Set<string>; values: Map<string, string[]> }

const VALUE_OPTIONS = new Set([
  '--config', '--stale-after', '-o', '--title', '--section', '--dir', '--mine', '--today', '--template', '--only', '--root', '--target', '--since',
  '--max-tokens', '--tokenizer', '--status', '--owner', '--repo', '--label', '--format', '--summary', '--out', '--base', '--url', '--image',
  '--lang', '--to', '--pandoc', '--reference-doc', '--browser', '--engine', '--price', '--agent', '--command', '--provenance',
  '--follow', '--direction', '--depth', '--view', '--order', '--from',
  '--text', '--by', '--reason', '--kind',
]);

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  const args: Args = { command, positional: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      // End of options: the rest are files, even ones that start with "-" (as Git hooks may pass them).
      args.positional.push(...rest.slice(i + 1));
      break;
    }
    if (VALUE_OPTIONS.has(a)) {
      const list = args.values.get(a) ?? [];
      list.push(rest[++i] ?? '');
      args.values.set(a, list);
    } else if (a.startsWith('-')) {
      args.flags.add(a);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

function main(argv: string[]): number | Promise<number> {
  const args = parseArgs(argv);
  const { command, positional, flags } = args;
  const value = (name: string) => args.values.get(name)?.[0];
  const today = value('--today');
  const staleAfter = value('--stale-after');
  const staleAfterDays = staleAfter === undefined ? undefined : Number(staleAfter);
  if (staleAfterDays !== undefined && !(staleAfterDays >= 0)) return fail('--stale-after needs a number of days (0 turns the check off).');

  switch (command) {
    case 'read':
      return readCommand(requireFile(positional[0]), args, today);
    case 'savings':
      return runSavings(positional.length ? positional : ['.'], { json: flags.has('--json'), price: value('--price'), today });
    case 'outline':
      return outlineFile(requireFile(positional[0]), flags.has('--related'), today, value('--tokenizer'));
    case 'agent':
      return agentFile(requireFile(positional[0]), args, today);
    case 'tasks':
      return tasks(positional.length ? positional : ['.'], args, today);
    case 'risks':
      return risks(positional, args);
    case 'trace':
      return trace(positional, args, today);
    case 'query':
      return query(positional[0], positional.slice(1), {
        json: flags.has('--json'), titles: flags.has('--titles'), brief: flags.has('--brief'), lineRefs: !flags.has('--no-lines'), today,
        constraints: flags.has('--constraints'), follow: value('--follow'), direction: value('--direction'), depth: value('--depth'),
        contract: flags.has('--contract'),
      }, args);
    case 'rev': {
      const out = runRev(positional[0], positional.slice(1), flags.has('--json'));
      process.stdout.write(out.stdout);
      process.stderr.write(out.stderr);
      return out.code;
    }
    case 'updates': {
      const out = runUpdates(positional[0], value('--since'), { json: flags.has('--json'), today });
      process.stdout.write(out.stdout);
      process.stderr.write(out.stderr);
      return out.code;
    }
    case 'diff':
      return diff(positional, value('--since'), { json: flags.has('--json'), brief: flags.has('--brief'), lineRefs: !flags.has('--no-lines'), exitCode: flags.has('--exit-code'), today });
    case 'meta': {
      const file = requireFile(positional[0]);
      const rules = configFor(file, value('--config')).rules;
      const info = getDocumentInfo(read(file), { fileExists: existsFrom(file), readFile: readerFor(file), today, rules, staleAfterDays });
      if (flags.has('--no-diagnostics')) delete (info as Partial<typeof info>).diagnostics;
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
      return 0;
    }
    case 'decisions':
      return decisions(positional, args);
    case 'report':
      return report(positional, args);
    case 'issues':
      return issues(positional, args);
    case 'index':
      return index(positional, value('-o'), flags.has('--compact'), today);
    case 'validate':
      return validate(positional.length ? positional : ['.'], args, today, staleAfterDays);
    case 'fmt':
      return fmt(positional.length ? positional : ['.'], flags.has('--check'), flags.has('--stdout'));
    case 'merge':
      return runMerge(positional, args);
    case 'review':
      return runReview(args);
    case 'migrate':
      return runMigrate(positional.length ? positional : ['.'], args);
    case 'build':
      return build(positional, args);
    // smd export, and the older names of its formats, kept as aliases (exportCommand.ts).
    case 'export':
    case 'render':
    case 'to-md':
    case 'pdf':
    case 'docx':
      return runExport(command, args);
    case 'from-md':
      return fromMd(requireFile(positional[0]), value('--from'), value('-o'), today);
    case 'init': {
      if (args.values.has('--agent')) return initAgents(args);
      const file = positional[0];
      if (!file) return fail('init needs a file name, e.g. smd init docs/plan.smd');
      if (fs.existsSync(file)) return fail(`${file} already exists.`);
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      const name = value('--template') ?? 'prd';
      const tpl = Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name] : undefined;
      if (!tpl) return fail(`Unknown template "${name}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
      fs.writeFileSync(file, fillTemplate(tpl.text, value('--title') ?? path.basename(file, '.smd'), today));
      console.log(`Created ${file} from the "${name}" template. Fill in the placeholders, then run: smd validate ${file}`);
      return 0;
    }
    case 'templates':
      for (const [name, t] of Object.entries(TEMPLATES)) console.log(`${name.padEnd(15)} ${t.description}`);
      return 0;
    case 'mcp':
      return mcp(value('--root'), { allowWrite: flags.has('--allow-write'), allowSuggest: flags.has('--allow-suggest'), legacyTools: flags.has('--legacy-tools') });
    case 'lsp':
      return lsp(flags);
    case 'skills':
      return skillsCommand(args);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    case '--version':
    case '-v':
      console.log(`smd ${pkg.version} (Semantic Markdown spec v${LATEST_SPEC})`);
      return 0;
    default:
      return fail(`Unknown command "${command}".\n\n${HELP}`);
  }
}

/**
 * `smd from-md`: plain Markdown as before, or with `--from` a file another tool wrote (a MADR decision record, a Spec
 * Kit tasks.md). What an importer keeps as text instead of mapping is a warning on stderr; the exit code stays 0.
 */
function fromMd(file: string, from: string | undefined, out: string | undefined, today: string | undefined): number {
  const title = path.basename(file, path.extname(file));
  if (from === undefined) return write(out, markdownToSmd(read(file), title));
  const convert = from === 'madr' ? madrToSmd : from === 'spec-kit' ? specKitTasksToSmd : undefined;
  if (!convert) return fail(`--from needs one of: ${IMPORT_FORMATS.join(', ')} (got "${from}").`);
  const result = convert(read(file), title, { today });
  for (const warning of result.warnings) console.error(`[smd] warning: ${file}: ${warning}`);
  return write(out, result.text);
}

/** `smd validate` output formats: `--json` is short for `--format json`. */
const VALIDATE_FORMATS = ['text', 'json', 'github'];

interface Validation { files: number; report: FileReport[]; configProblems: ConfigProblem[]; errors: number; warnings: number }

async function validate(targets: string[], args: Args, today?: string, staleAfterDays?: number): Promise<number> {
  const format = validateFormat(args);
  if (!format) return fail(`--format needs one of: ${VALIDATE_FORMATS.join(', ')} (--json is --format json).`);
  const files = targets.flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const { report, configProblems } = await checkFiles(files, args, { today, staleAfterDays });
  const all = report.flatMap((r) => r.diagnostics);
  const errors = all.filter((d) => d.severity === 'error').length;
  const warnings = all.filter((d) => d.severity === 'warning').length + configProblems.length;
  const result: Validation = { files: files.length, report, configProblems, errors, warnings };
  VALIDATE_PRINTERS[format](result);
  const summary = args.values.get('--summary')?.[0];
  if (summary) fs.appendFileSync(summary, validationSummary(ciResult(result), { linkBase: blobBase(process.env) }) + '\n');
  return errors > 0 || (args.flags.has('--strict') && warnings > 0) ? 1 : 0;
}

/** The chosen output format, or undefined when it is unknown or conflicts with `--json`. */
function validateFormat(args: Args): string | undefined {
  const json = args.flags.has('--json');
  const format = args.values.get('--format')?.[0] ?? (json ? 'json' : 'text');
  if (json && format !== 'json') return undefined;
  return VALIDATE_FORMATS.includes(format) ? format : undefined;
}

/** Check (and with `--fix`, fix) each file under its nearest rule config; config problems go to stderr once per file. */
async function checkFiles(
  files: string[], args: Args, options: { today?: string; staleAfterDays?: number },
): Promise<{ report: FileReport[]; configProblems: ConfigProblem[] }> {
  const report: FileReport[] = [];
  const configProblems: ConfigProblem[] = [];
  const configs = new Map<string, LoadedConfig>();
  const parse = args.flags.has('--no-mermaid') ? undefined : loadMermaidParser();
  for (const file of files) {
    const config = configFor(file, args.values.get('--config')?.[0], configs);
    reportConfigProblems(config, configProblems);
    const check = (text: string) => diagnose(text, file, { rules: config.rules, ...options, parse });
    const text = read(file);
    const result = args.flags.has('--fix') ? await fixUntilStable(text, check) : { text, diagnostics: await check(text), applied: 0 };
    if (result.applied) fs.writeFileSync(file, result.text);
    report.push({ file, diagnostics: result.diagnostics, ...(result.applied ? { fixed: result.applied } : {}) });
  }
  return { report, configProblems };
}

/** Print a config file's problems to stderr and collect them, the first time the file is seen. */
function reportConfigProblems(config: LoadedConfig, seen: ConfigProblem[]): void {
  const file = config.file;
  if (!file || !config.problems.length || seen.some((p) => p.file === file)) return;
  for (const p of config.problems) console.error(`${file}: warning  ${p}`);
  seen.push(...config.problems.map((message) => ({ file, message })));
}

const VALIDATE_PRINTERS: Record<string, (result: Validation) => void> = {
  text: printValidationText,
  json: ({ report, errors, warnings }) => process.stdout.write(JSON.stringify({ files: report, errors, warnings }, null, 2) + '\n'),
  github: (result) => {
    for (const line of githubAnnotations(ciResult(result))) console.log(line);
  },
};

function printValidationText({ files, report, errors, warnings }: Validation): void {
  const color = process.stdout.isTTY;
  const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const sev = { error: paint(31, 'error'), warning: paint(33, 'warning'), info: paint(36, 'info'), hint: paint(90, 'hint') };
  for (const r of report) {
    if (r.fixed) console.log(`${r.file}: applied ${r.fixed} fix(es)`);
    for (const d of r.diagnostics) {
      console.log(`${r.file}:${d.line + 1}:${d.column + 1}  ${sev[d.severity]}  ${d.message}  ${paint(90, d.code)}`);
    }
  }
  console.log(`\n${files} file(s) checked: ${errors} error(s), ${warnings} warning(s).`);
}

/** The result with paths relative to the repository root (`GITHUB_WORKSPACE`, else the working directory), as GitHub expects. */
function ciResult({ report, configProblems }: Validation): ValidationResult {
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const rel = (file: string) => path.relative(root, path.resolve(file)).split(path.sep).join('/');
  return {
    files: report.map((r) => ({ ...r, file: rel(r.file) })),
    configProblems: configProblems.map((p) => ({ ...p, file: rel(p.file) })),
  };
}

/** Rounds of `--fix`: one fix can make another possible, e.g. a code block closed before its container. */
const FIX_PASSES = 5;

/** Apply fixes and check again until none apply, so `--fix` leaves nothing it could still fix. */
async function fixUntilStable(
  text: string, check: (text: string) => Promise<Diagnostic[]>,
): Promise<{ text: string; diagnostics: Diagnostic[]; applied: number }> {
  let current = text;
  let diagnostics = await check(current);
  let applied = 0;
  for (let pass = 0; pass < FIX_PASSES; pass++) {
    const result = applyFixes(current, diagnostics);
    if (!result.applied) break;
    current = result.text;
    applied += result.applied;
    diagnostics = await check(current);
  }
  return { text: current, diagnostics, applied };
}

/** Rule settings for a file: from `--config`, else the nearest config file. */
function configFor(file: string, configFile?: string, cache?: Map<string, LoadedConfig>): LoadedConfig {
  if (!configFile) return loadRuleConfig(file, cache);
  const key = `explicit:${configFile}`;
  const cached = cache?.get(key);
  if (cached) return cached;
  const config = fs.existsSync(configFile) ? readConfigFile(configFile) : { file: configFile, rules: {}, problems: ['Config file not found.'] };
  cache?.set(key, config);
  return config;
}

function fmt(targets: string[], check: boolean, stdout: boolean): number {
  if (stdout) {
    if (targets.length !== 1 || !fs.existsSync(targets[0]) || !fs.statSync(targets[0]).isFile()) return fail('--stdout needs exactly one file.');
    process.stdout.write(formatSmd(read(targets[0])));
    return 0;
  }
  const files = targets.flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const changed: string[] = [];
  for (const file of files) {
    const text = read(file);
    const formatted = formatSmd(text);
    if (formatted === text) continue;
    changed.push(file);
    if (!check) fs.writeFileSync(file, formatted);
    console.log(check ? `${file}: not formatted` : `${file}: formatted`);
  }
  console.log(`
${files.length} file(s) checked: ${changed.length} ${check ? 'need formatting' : 'formatted'}.`);
  return check && changed.length ? 1 : 0;
}

const TASK_FORMATS = ['--json', '--csv', '--gantt'];

function tasks(targets: string[], args: Args, today?: string): number {
  const [format, ...more] = TASK_FORMATS.filter((f) => args.flags.has(f));
  if (more.length) return fail(`Choose one output format: ${[format, ...more].join(' or ')}.`);
  if (args.flags.has('--smd') && format !== '--gantt') return fail('--smd wraps the Gantt chart in a document: use it with --gantt.');
  const files = targets.flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const all = args.flags.has('--all');
  const order = args.values.get('--order')?.[0] ?? 'priority';
  if (order !== 'priority' && order !== 'deps') return fail(`--order is priority (the default) or deps, not "${order}".`);
  const rows = taskRows(files, { all, mine: args.values.get('--mine')?.[0], today, order });
  const out = args.values.get('-o')?.[0];
  if (format === '--json') return write(out, JSON.stringify(rows, null, 2) + '\n');
  if (format === '--gantt') return taskGantt(rows, args, out);
  const text = format === '--csv' ? tasksToCsv(rows) : rows.map((r) => taskLine(r) + '\n').join('');
  const code = write(out, text);
  console.error(`[smd] ${taskSummary(rows, all)}`);
  // A checked box is an implementation claim (research contract, "Tasks").
  console.error(`[smd] ${TASK_CLAIMS}`);
  return code;
}

const TASK_CLAIMS = 'Checked boxes are implementation claims, not verification: smd trace shows the evidence.';

/** `smd tasks --gantt [--smd] [--title …]`: the chart, or a document with it, and how many tasks it shows. */
function taskGantt(rows: TaskRow[], args: Args, out?: string): number {
  const title = args.values.get('--title')?.[0];
  const chart = tasksToGantt(rows, { title });
  const code = write(out, args.flags.has('--smd') ? ganttDocument(chart, title) : chart);
  const charted = rows.filter((r) => ganttDate(r.due)).length;
  const left = rows.length - charted;
  const skipped = left ? `, ${left} without a YYYY-MM-DD due date left out` : '';
  console.error(`[smd] ${charted} task(s) on the chart${skipped}.`);
  return code;
}

/**
 * `smd trace`: each requirement's status, coverage, claims, evidence and human acceptance, then the counts (in the
 * JSON too, as `summary`).
 */
function trace(targets: string[], args: Args, today?: string): number {
  const files = (targets.length ? targets : ['.']).flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const documents = files.map((file) => ({ path: relativePath(file), text: read(file) }));
  const result = traceRequirements(documents, { uncovered: args.flags.has('--uncovered'), today });
  if (args.flags.has('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }
  if (!result.requirements.length) {
    console.log(traceSummary(result.summary));
    return 0;
  }
  process.stdout.write(formatTrace(result));
  return 0;
}

/** `smd risks`: the register as text, JSON or a standalone HTML page. Closed risks only with --all or --status. */
function risks(targets: string[], args: Args): number {
  const status = (args.values.get('--status') ?? []).flatMap((s) => s.split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = status.find((s) => !RISK_STATUS.includes(s));
  if (unknown) return fail(`Unknown risk status "${unknown}". Statuses: ${RISK_STATUS.join(', ')}`);
  const files = (targets.length ? targets : ['.']).flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const documents = files.map((file) => ({ path: relativePath(file), text: read(file) }));
  const options = { status, owner: args.values.get('--owner')?.[0], all: args.flags.has('--all') };
  const register = riskRegister(documents, options);
  console.error(`[smd] ${riskRegisterSummary(register, options)}`);
  const out = args.values.get('-o')?.[0];
  if (args.flags.has('--html')) return write(out, renderRiskPage(register));
  return write(out, args.flags.has('--json') ? JSON.stringify(register, null, 2) + '\n' : riskRegisterText(register));
}

function query(selector: string | undefined, targets: string[], flags: QueryFlags, args: Args): number {
  // --provenance goes with --contract; without it the option is ignored, as it always was.
  const manifest = flags.contract ? provenanceTarget(args) : undefined;
  if (manifest === null) return fail(PROVENANCE_USAGE);
  const { code, stdout, stderr, manifests } = runQuery(selector, targets, { ...flags, provenance: manifest !== undefined });
  if (manifest && manifests) writeProvenanceList(manifest, manifests);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return code;
}

async function mcp(root = '.', options: { allowWrite: boolean; allowSuggest: boolean; legacyTools: boolean }): Promise<number> {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return fail(`--root must be a folder: ${root}`);
  await runMcpServer({ root, version: pkg.version, ...options });
  return 0;
}

/** The language server speaks stdio only; other transports that clients may ask for are refused. */
async function lsp(flags: Set<string>): Promise<number> {
  const transport = [...flags].find((f) => /^--(?:socket|pipe|node-ipc)\b/.test(f));
  if (transport) return fail(`smd lsp supports --stdio only (got ${transport}).`);
  return runLanguageServer({ version: pkg.version });
}

function outlineFile(file: string, related: boolean, today?: string, tokenizerName?: string): number {
  return withTokenizer(tokenizerName, (tokenizer) => {
    const text = read(file);
    process.stdout.write(outline(text, { readFile: readerFor(file), today, tokenizer }));
    if (related) process.stdout.write(relatedBlock(file, text, today));
    return 0;
  });
}

/** Run with the `--tokenizer` given (if any), or fail with its install hint. */
function withTokenizer(name: string | undefined, run: (tokenizer?: Tokenizer) => number): number {
  if (name === undefined) return run(undefined);
  let tokenizer: Tokenizer;
  try {
    tokenizer = loadTokenizer(name);
  } catch (e) {
    if (e instanceof TokenizerError) return fail(e.message);
    throw e;
  }
  return run(tokenizer);
}

/** `--max-tokens`: undefined when not given, null when it isn't a positive whole number. */
function maxTokensOption(args: Args): number | undefined | null {
  const raw = args.values.get('--max-tokens')?.[0];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const MAX_TOKENS_USAGE = '--max-tokens needs a whole number of tokens, e.g. --max-tokens 2000.';

function agentFile(file: string, args: Args, today?: string): number {
  const maxTokens = maxTokensOption(args);
  if (maxTokens === null) return fail(MAX_TOKENS_USAGE);
  return withTokenizer(args.values.get('--tokenizer')?.[0], (tokenizer) => printAgentView(file, args, { maxTokens, tokenizer, today }));
}

/** `smd read`: the whole agent view when it fits the budget, else the outline. */
function readCommand(file: string, args: Args, today?: string): number {
  const maxTokens = maxTokensOption(args);
  if (maxTokens === null) return fail(MAX_TOKENS_USAGE);
  const { flags } = args;
  if (flags.has('--outline') && flags.has('--full')) return fail('Use either --outline or --full, not both.');
  let mode: ReadMode = 'auto';
  if (flags.has('--outline')) mode = 'outline';
  else if (flags.has('--full')) mode = 'full';
  const sections = args.values.get('--section');
  const manifest = provenanceTarget(args);
  if (manifest === null) return fail(PROVENANCE_USAGE);
  const follow = args.values.get('--follow')?.[0];
  const graph = followOptions({ follow, direction: args.values.get('--direction')?.[0], depth: args.values.get('--depth')?.[0] });
  if ('error' in graph) return fail(graph.error);
  const taskView = args.values.has('--view') || flags.has('--views');
  if (follow !== undefined && taskView) return fail('--follow goes with smd read without --view: a task view follows the edges its author declared.');
  if (follow !== undefined && mode === 'outline') return fail('--follow follows the edges of the content read, so it does not go with --outline.');
  // A task view is read as smd agent reads it: its own budget, or --max-tokens as the agent's.
  if (taskView) {
    return withTokenizer(args.values.get('--tokenizer')?.[0], (tokenizer) => printTaskView(file, args, { maxTokens, tokenizer, today }, manifest));
  }
  // Other files are read only inside the document's folder, which `in` also searches for edges that point here.
  const folder = path.dirname(file);
  const others = follow !== undefined && graph.direction !== 'out'
    ? collect(folder).filter((f) => path.resolve(f) !== path.resolve(file)).map((f) => ({ path: f, text: read(f) }))
    : undefined;
  return withTokenizer(args.values.get('--tokenizer')?.[0], (tokenizer) => {
    const result = readDocument(read(file), {
      mode, maxTokens, sections, exactSections: flags.has('--exact'), brief: flags.has('--brief'), lineRefs: !flags.has('--no-lines'),
      readFile: readerFor(file), today, file, tokenizer, constraints: flags.has('--constraints'), provenance: manifest !== undefined,
      ...(follow !== undefined ? { follow, ...graph, readDocument: graphReader([folder]), ...(others ? { documents: others } : {}) } : {}),
    });
    if (result.missingSections.length) {
      console.error(`No section matching: ${result.missingSections.join(', ')}. Run "smd read ${file} --outline" to list sections.`);
      if (result.missingSections.length === sections?.length) return 1;
    }
    if (manifest && result.provenance) writeProvenance(manifest, result.provenance);
    process.stdout.write(result.text);
    const exact = result.counted ? ` (${result.counted.tokens} ${result.counted.tokenizer})` : '';
    console.error(`[smd] ${result.shown} · agent view ≈${result.fullTokens} tokens${exact} · file ≈${result.fileTokens} tokens`);
    if (result.shown !== 'outline') warnIncomplete(result.mandatory);
    if (follow !== undefined) for (const line of followLines(result)) console.error(line);
    return 0;
  });
}

/** What `smd read --follow` added, after the size line: as `smd query --follow` sums it up. */
function followLines(result: ReadResult): string[] {
  const f = result.follow;
  if (!f) return ['[smd] --follow: no edges followed, since this is the outline. Read sections with --section, or use --full.'];
  const unit = result.counted ? `${result.counted.tokenizer} tokens` : 'tokens';
  const approx = result.counted ? '' : '≈';
  const parts = [`[smd] followed: ${f.neighbors.length} neighbor(s) as pointers (≈${f.tokens.pointers} tokens not read).`];
  if (f.dependencies.length) parts.push(`${f.dependencies.length} dependenc${f.dependencies.length === 1 ? 'y' : 'ies'} included (≈${f.tokens.dependencies} tokens).`);
  parts.push(`${approx}${f.tokens.shown} ${unit} added after the view.`);
  const lines = [parts.join(' ')];
  const n = f.unsatisfied.length;
  if (n) lines.push(`[smd] warning: incomplete, ${n} mandatory dependenc${n === 1 ? 'y is' : 'ies are'} not satisfied along the followed edges (listed after the view)`);
  return lines;
}

/** `--provenance <file>`: undefined when not given, null when it has no file name. */
function provenanceTarget(args: Args): string | undefined | null {
  const raw = args.values.get('--provenance')?.[0];
  if (raw === undefined) return undefined;
  return raw.trim() && !raw.startsWith('-') ? raw : null;
}

const PROVENANCE_USAGE = '--provenance needs a file to write the manifest to, e.g. --provenance view.json.';

/** A view that could not carry or resolve what it must says so on stderr too, by part (t-63); the view lists them. */
function warnIncomplete(mandatory: AgentViewResult['mandatory']): void {
  if (!mandatory?.unsatisfied.length) return;
  const what = incompleteLine(mandatory.unsatisfied).slice('[incomplete: '.length, -1);
  console.error(`[smd] warning: incomplete view, ${what} (listed under "Not satisfied")`);
}

function writeProvenance(target: string, manifest: Provenance): void {
  fs.writeFileSync(target, JSON.stringify({ ...manifest, settings: { tool: `smd ${pkg.version}`, ...manifest.settings } }, null, 2) + '\n');
}

/** `smd query --contract --provenance <file>`: the manifests of the views, one per document with matches, as an array. */
function writeProvenanceList(target: string, manifests: Provenance[]): void {
  const tool = `smd ${pkg.version}`;
  fs.writeFileSync(target, JSON.stringify(manifests.map((m) => ({ ...m, settings: { tool, ...m.settings } })), null, 2) + '\n');
}

function printAgentView(file: string, args: Args, extra: Pick<AgentViewOptions, 'maxTokens' | 'tokenizer' | 'today'>): number {
  const sections = args.values.get('--section');
  const manifest = provenanceTarget(args);
  if (manifest === null) return fail(PROVENANCE_USAGE);
  if (args.values.has('--view') || args.flags.has('--views')) return printTaskView(file, args, extra, manifest);
  const result = agentView(read(file), {
    sections,
    exactSections: args.flags.has('--exact'),
    brief: args.flags.has('--brief'),
    includeHuman: args.flags.has('--include-human'),
    embed: args.flags.has('--embed'),
    includes: !args.flags.has('--no-includes'),
    lineRefs: !args.flags.has('--no-lines'),
    constraints: args.flags.has('--constraints'),
    provenance: manifest !== undefined,
    ...(args.flags.has('--evidence') ? { evidence: 'full' as const } : {}),
    readFile: readerFor(file),
    file,
    ...extra,
  });
  if (result.missingSections.length) {
    console.error(`No section matching: ${result.missingSections.join(', ')}. Run "smd outline ${file}" to list sections.`);
    if (result.missingSections.length === (sections?.length ?? 0)) return 1;
  }
  if (manifest && result.provenance) writeProvenance(manifest, result.provenance);
  process.stdout.write(result.text);
  console.error(sizeLine(result));
  if (result.budget) for (const line of budgetLines(result.budget, result.counted?.tokenizer, !!result.resolvedSections)) console.error(line);
  warnIncomplete(result.mandatory);
  return 0;
}

/** `smd agent <file> --view <name> [--inspect]` and `--views`: an author task view, with the agent's flags on top. */
function printTaskView(file: string, args: Args, extra: Pick<AgentViewOptions, 'maxTokens' | 'tokenizer' | 'today'>, manifest: string | undefined): number {
  const out = runTaskView(read(file), file, {
    view: args.values.get('--view')?.[0],
    list: args.flags.has('--views'),
    inspect: args.flags.has('--inspect'),
    sections: args.values.get('--section'),
    exactSections: args.flags.has('--exact'),
    brief: args.flags.has('--brief'),
    includeHuman: args.flags.has('--include-human'),
    embed: args.flags.has('--embed'),
    includes: !args.flags.has('--no-includes'),
    lineRefs: !args.flags.has('--no-lines'),
    constraints: args.flags.has('--constraints'),
    provenance: manifest !== undefined,
    readFile: readerFor(file),
    readDocument: graphReader([path.dirname(file)]),
    ...extra,
  });
  if (manifest && out.provenance) writeProvenance(manifest, out.provenance);
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  return out.code;
}

/** `[smd] ≈1531 tokens (file ≈2430, 37% smaller)`, with a tokenizer `[smd] ≈1531 est · 1402 o200k_base tokens (…)` */
function sizeLine(result: AgentViewResult): string {
  const counted = result.counted;
  const [tokens, original] = counted ? [counted.tokens, counted.originalTokens] : [result.tokens, result.originalTokens];
  const saved = original ? Math.round((1 - tokens / original) * 100) : 0;
  if (!counted) return `[smd] ≈${tokens} tokens (file ≈${original}, ${saved}% smaller)`;
  const exact = counted.tokenizer;
  return `[smd] ≈${result.tokens} est · ${tokens} ${exact} tokens (file ≈${result.originalTokens} est · ${original} ${exact}, ${saved}% smaller)`;
}

/**
 * What `--max-tokens` did, and a warning when even the smallest view is over the budget. The warning suggests fewer
 * sections only when sections were requested (contract GAP-10).
 */
function budgetLines(budget: BudgetResult, tokenizer?: string, sectionsRequested = false): string[] {
  const unit = tokenizer ? `${tokenizer} tokens` : 'tokens';
  const size = tokenizer ? `${budget.tokens} ${unit}` : `≈${budget.tokens} ${unit}`;
  const steps = [
    budget.condensed ? 'condensed as --brief' : '',
    budget.omitted.length ? `omitted ${budget.omitted.length} section(s): ${budget.omitted.map(omittedLabel).join(', ')}` : '',
  ].filter(Boolean);
  const lines = [`[smd] budget ${budget.maxTokens} ${unit}: ${steps.join('; ') || 'fits as is'}; now ${size}.`];
  if (!budget.fits) {
    const ask = sectionsRequested
      ? 'ask for fewer sections or a larger budget.'
      : 'ask for a larger budget, or read one section at a time with --section.';
    lines.push(`[smd] warning: still over the budget of ${budget.maxTokens} ${unit}. The header, agent instructions, `
      + `dangers and requested sections are never omitted; ${ask}`);
  }
  return lines;
}

function omittedLabel(o: BudgetResult['omitted'][number]): string {
  return `${'#'.repeat(o.level)} ${o.heading} (≈${o.tokens})`;
}

/** `smd outline --related`: the related documents, with paths relative to the working directory. */
function relatedBlock(file: string, text: string, today?: string): string {
  const dir = path.dirname(path.resolve(file));
  const docs = relatedDocs(text, { readFile: readerFor(file), today })
    .map((d) => (d.path === undefined ? d : { ...d, path: displayPath(dir, d.path) }));
  const block = formatRelated(docs);
  return block ? '\n' + block : '';
}

function displayPath(dir: string, rel: string): string {
  return relativePath(path.resolve(dir, rel));
}

function index(targets: string[], out: string | undefined, compact: boolean, today?: string): number {
  const files = (targets.length ? targets : ['.']).flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const documents = files.map((file) => ({ path: relativePath(file), text: read(file) }));
  const catalog = smdIndex(documents, { today, generator: `smd ${pkg.version}` });
  const json = compact ? JSON.stringify(catalog) : JSON.stringify(catalog, null, 2);
  const tokens = catalog.documents.reduce((sum, d) => sum + d.tokens.agent, 0);
  console.error(`[smd] ${catalog.documents.length} document(s) indexed, ≈${tokens} tokens in full agent view.`);
  return write(out, json + '\n');
}

/** `smd build <dir>`: the static site; see siteBuild.ts for what it may write and delete. */
function build(positional: string[], args: Args): number {
  if (positional.length !== 1) return fail('Usage: smd build <dir> [--out site] [--title "…"] [--base /docs/] [--md] [--clean]');
  const value = (name: string) => args.values.get(name)?.[0];
  const lang = langOption(value('--lang'));
  if (lang === null) return fail(LANG_USAGE);
  const url = value('--url');
  if (url !== undefined && !isHttpUrl(url)) return fail('--url must be an http(s) address, e.g. https://example.com/docs/');
  return runBuild({
    dir: positional[0],
    out: value('--out') ?? 'site',
    title: value('--title'),
    base: value('--base'),
    url,
    image: value('--image'),
    today: value('--today'),
    lang,
    md: args.flags.has('--md'),
    clean: args.flags.has('--clean'),
    comments: args.flags.has('--comments'),
    generator: `smd ${pkg.version}`,
  }, { err: (text) => console.error(text) });
}

/** `smd decisions`: the decision log as text, JSON (`--json`) or an ADR index document (`--md`). */
function decisions(targets: string[], args: Args): number {
  const status = statusFilter(args.values.get('--status'));
  if (typeof status === 'string') return fail(status);
  const files = (targets.length ? targets : ['.']).flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const documents = files.map((file) => ({ path: relativePath(file), text: read(file) }));
  const rows = decisionLog(documents, { status, owner: args.values.get('--owner')?.[0] });
  const out = args.values.get('-o')?.[0];
  console.error(`[smd] ${decisionSummary(rows, files.length)}`);
  if (args.flags.has('--json')) return write(out, JSON.stringify(rows, null, 2) + '\n');
  if (!args.flags.has('--md')) return write(out, rows.map((r) => decisionLine(r) + '\n').join(''));
  const base = out ? path.dirname(path.resolve(out)) : process.cwd();
  const link = (p: string) => path.relative(base, path.resolve(p)).split(path.sep).join('/');
  return write(out, decisionLogMarkdown(rows, { title: args.values.get('--title')?.[0], link }));
}

/** `smd report`: a draft status report comparing the documents with their version at --since. */
function report(positional: string[], args: Args): number {
  const since = args.values.get('--since')?.[0];
  if (!since || since.startsWith('-')) return fail('report needs --since <date|git-ref>, e.g. smd report docs/ --since 2026-09-01 -o status.smd');
  const out = args.values.get('-o')?.[0];
  if (out && fs.existsSync(out)) return fail(`${out} already exists. The report is a draft to edit: choose another -o file or remove it first.`);
  const targets = positional.length ? positional : ['.'];
  const files = targets.filter((t) => fs.existsSync(t)).flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  const base = baseline(since, targets, files);
  if (typeof base === 'string') return fail(base);
  const options = { since, revision: base.revision, today: args.values.get('--today')?.[0], title: args.values.get('--title')?.[0] };
  const changes = statusChanges(base.before, files.map((file) => ({ path: relativePath(file), text: read(file) })), options);
  console.error(`[smd] ${reportSummary(changes, files.length, since, base.revision)}`);
  const dir = out ? path.dirname(path.resolve(out)) : process.cwd();
  const link = (p: string) => path.relative(dir, path.resolve(p)).split(path.sep).join('/');
  return write(out, statusReportMarkdown(changes, { ...options, link }));
}

interface Baseline { before: ReportDocument[] | null; revision?: string }

/** The documents at --since: a Git revision, or the last commit before a date. Null without history; a message on error. */
function baseline(since: string, targets: string[], files: string[]): Baseline | string {
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(since);
  const top = git(['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return isDate ? { before: null } : `--since ${since} needs a Git repository; outside one, give a date (YYYY-MM-DD) to report the current state.`;
  const commit = isDate ? git(['rev-list', '-1', `--before=${since}T00:00:00`, 'HEAD']) : git(['rev-parse', '--verify', '--quiet', `${since}^{commit}`]);
  if (commit === undefined) return isDate ? { before: null } : `Unknown Git revision "${since}".`;
  // No commit before the date: the documents didn't exist yet, so every task is new.
  if (!commit.trim()) return { before: [], revision: 'before the first commit' };
  return { before: versionAt(commit.trim(), top, targets, files), revision: commit.trim().slice(0, 7) };
}

/** The documents as they were at a commit, including ones deleted since, labelled with their working-tree paths. */
function versionAt(commit: string, top: string, targets: string[], files: string[]): ReportDocument[] {
  const at = (topPath: string, file: string): ReportDocument[] => {
    const text = git(['show', `${commit}:${topPath}`]);
    return text === undefined ? [] : [{ path: relativePath(file), text }];
  };
  return [
    ...files.flatMap((file) => at(gitPath(top, file), file)),
    ...deletedSince(commit, targets, top).flatMap((p) => at(p, workingPath(top, p))),
  ];
}

/** `--status accepted,open` (repeatable) as a list; a message when a status is unknown. */
function statusFilter(values: string[] | undefined): string[] | string | undefined {
  if (!values) return undefined;
  const list = values.flatMap((v) => v.split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const known = `Statuses: ${DECISION_STATUS_FILTERS.join(', ')} (open = proposed).`;
  if (!list.length) return `--status needs one or more decision statuses. ${known}`;
  const unknown = list.find((s) => !DECISION_STATUS_FILTERS.includes(s));
  if (unknown === undefined) return list;
  const hint = suggest(unknown, DECISION_STATUS_FILTERS);
  const didYouMean = hint ? ` Did you mean "${hint}"?` : '';
  return `Unknown decision status "${unknown}".${didYouMean} ${known}`;
}

/** `docs/plan.smd`: relative to the working directory, with forward slashes on every platform. */
function relativePath(file: string): string {
  return path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/');
}

/** `smd skills install [--target …]`: Claude skills (the default) and/or instruction files for other agents. */
function skillsCommand(args: Args): number {
  if (args.positional[0] !== 'install') return fail(SKILLS_USAGE);
  let targets: AgentTarget[];
  try {
    targets = parseTargets(args.values.get('--target') ?? []);
  } catch (e) {
    return fail((e as Error).message);
  }
  const problem = targetOptionsProblem(targets, args);
  if (problem) return fail(problem);
  const others = targets.filter((t): t is RulesTarget => t !== 'claude');
  const code = targets.includes('claude') ? installSkills(claudeSkillsDir(args), args.values.get('--only')?.[0]) : 0;
  return code || !others.length ? code : installAgentRules(others, args.values.get('--dir')?.[0] ?? '.');
}

function claudeSkillsDir(args: Args): string {
  if (args.flags.has('--global')) return path.join(os.homedir(), '.claude', 'skills');
  return args.values.get('--dir')?.[0] ?? path.join('.claude', 'skills');
}

/** Options that only make sense for the Claude skills, or that would mean two different folders at once. */
function targetOptionsProblem(targets: AgentTarget[], args: Args): string | undefined {
  const claude = targets.includes('claude');
  const others = targets.length > (claude ? 1 : 0);
  if (!others) return undefined;
  if (args.flags.has('--global')) return '--global only applies to --target claude. Install rules for other agents per project (--dir <project>).';
  if (!claude && args.values.has('--only')) return '--only only applies to --target claude. The rules for other agents cover reading and writing.';
  if (claude && args.values.has('--dir')) return '--dir is the skills folder for --target claude but the project root for other targets. Install them in separate runs.';
  return undefined;
}

/** Writes the shared CLI to <root>/.smd/smd.cjs and each target's instruction file. */
function installAgentRules(targets: RulesTarget[], root: string): number {
  const cli = path.resolve(root, SHARED_CLI_PATH);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.copyFileSync(__filename, cli);
  console.log(`Installed smd CLI → ${cli}  (agents run it as: ${SHARED_CLI_COMMAND})`);
  const body = rulesBody(AGENT_RULES);
  try {
    for (const target of targets) writeTargetFile(TARGET_FILES[target], root, body);
  } catch (e) {
    return fail((e as Error).message);
  }
  return 0;
}

/** `smd init --agent …`: skills or rules, the CLI, and the MCP server config for each agent. */
function initAgents(args: Args): number {
  if (args.positional.length) return fail('smd init --agent sets up agents in a project folder (--dir); create documents in a separate smd init <file.smd>.');
  let targets: AgentTarget[];
  try {
    targets = parseTargets(args.values.get('--agent') ?? []);
  } catch (e) {
    return fail((e as Error).message.replace('--target', '--agent'));
  }
  const root = args.values.get('--dir')?.[0] ?? '.';
  fs.mkdirSync(root, { recursive: true });
  const others = targets.filter((t): t is RulesTarget => t !== 'claude');
  const code = (targets.includes('claude') ? installSkills(path.join(root, '.claude', 'skills')) : 0)
    || (others.length ? installAgentRules(others, root) : 0);
  if (code) return code;
  if (!args.flags.has('--no-mcp')) {
    for (const target of targets) {
      const spec = mcpConfigFor(target);
      if (spec && !writeMcpConfig(spec, root)) return 1;
    }
  }
  console.log(`Done. Restart the agent (or reload its MCP servers) to pick up the "${MCP_SERVER_NAME}" tools; agents can also run the CLI directly.`);
  return 0;
}

function writeMcpConfig(spec: McpConfigSpec, root: string): boolean {
  const file = path.resolve(root, spec.file);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  let content: string;
  try {
    content = mergeMcpConfig(existing, spec);
  } catch (e) {
    if (!(e instanceof McpConfigError)) throw e;
    console.error(e.message);
    return false;
  }
  if (content === existing) {
    console.log(`Unchanged ${file}  (MCP server "${MCP_SERVER_NAME}")`);
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.log(`${existing === undefined ? 'Created' : 'Updated'} ${file}  (MCP server "${MCP_SERVER_NAME}")`);
  return true;
}

function writeTargetFile(spec: TargetFile, root: string, body: string): void {
  const file = path.resolve(root, spec.file);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  const content = spec.render(body, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const verb = existing === undefined ? 'Created' : 'Updated';
  console.log(`${verb} ${file}  (${spec.label})`);
  if (spec.legacyFile) removeLegacyRules(path.resolve(root, spec.legacyFile));
}

/** The same rules under their pre-3.0 name would load twice: remove the old file, unless someone edited it by hand. */
function removeLegacyRules(file: string): void {
  if (!fs.existsSync(file)) return;
  if (!isGenerated(fs.readFileSync(file, 'utf8'))) {
    console.log(`Kept ${file}: it doesn't look generated by smd any more. Delete it if it only holds the old Styled Markdown rules.`);
    return;
  }
  fs.rmSync(file);
  console.log(`Removed ${file}  (the same rules under their pre-3.0 name)`);
}

interface DiffFlags { json: boolean; brief: boolean; lineRefs: boolean; exitCode: boolean; today?: string }
interface FileDiff { file: string; status: 'changed' | 'added' | 'deleted'; result: DiffResult }

function diff(positional: string[], since: string | undefined, flags: DiffFlags): number {
  if (since !== undefined) return diffSince(positional.length ? positional : ['.'], since, flags);
  if (positional.length !== 2) return fail('Usage: smd diff <old.smd> <new.smd>, or smd diff <files|dirs...> --since <git-ref>');
  const [oldFile, newFile] = positional.map((f) => requireFile(f));
  const result = diffSmd(read(oldFile), read(newFile), flags);
  const diffs: FileDiff[] = result.text ? [{ file: newFile, status: 'changed', result }] : [];
  return reportDiffs(diffs, 1, { oldFile }, flags);
}

/** Each .smd file under the targets against its version at a Git revision, including files deleted since. */
function diffSince(targets: string[], ref: string, flags: DiffFlags): number {
  if (!ref || ref.startsWith('-')) return fail('--since needs a Git commit, branch or tag, e.g. --since HEAD~1');
  const top = git(['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return fail('--since needs a Git repository: run smd diff inside one.');
  if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) === undefined) return fail(`Unknown Git revision "${ref}".`);
  const files = targets.filter((t) => fs.existsSync(t)).flatMap((t) => collect(t));
  const deleted = deletedSince(ref, targets, top);
  if (!files.length && !deleted.length) return fail('No .smd files found.');
  const diffs = [
    ...files.map((file) => fileSince(file, ref, top, flags)),
    ...deleted.map((p) => deletedFile(p, ref, top, flags)),
  ];
  return reportDiffs(diffs.filter((d) => d.status !== 'changed' || d.result.text), files.length + deleted.length, { since: ref }, flags);
}

function fileSince(file: string, ref: string, top: string, flags: DiffFlags): FileDiff {
  const old = git(['show', `${ref}:${gitPath(top, file)}`]);
  const text = read(file);
  const result = diffSmd(old ?? '', text, flags);
  if (old !== undefined) return { file, status: 'changed', result };
  // A new file: its whole agent view reads better than every section labelled "added".
  const view = agentView(text, { brief: flags.brief, lineRefs: flags.lineRefs, readFile: readerFor(file), today: flags.today });
  return { file, status: 'added', result: { ...result, text: view.text, tokens: view.tokens } };
}

function deletedFile(topPath: string, ref: string, top: string, flags: DiffFlags): FileDiff {
  const file = workingPath(top, topPath);
  return { file, status: 'deleted', result: diffSmd(git(['show', `${ref}:${topPath}`]) ?? '', '', flags) };
}

/** Run gh (the GitHub CLI) without a shell, `input` on stdin. Its own login is used: no token passes through smd. */
function gh(args: string[], input?: string): GhResult {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  try {
    const stdout = execFileSync('gh', args, { encoding: 'utf8', input, env, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }); // NOSONAR(typescript:S4036): smd issues runs the user's own gh, found on PATH like git for --since
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const stderr = err.stderr ? String(err.stderr) : err.message;
    return { ok: false, missing: err.code === 'ENOENT', stdout: String(err.stdout ?? ''), stderr };
  }
}

/** `smd issues`: the sync plan (a dry run), or with --apply the sync itself, through gh. */
function issues(targets: string[], args: Args): number {
  const labels = (args.values.get('--label') ?? []).flatMap((l) => l.split(',')).map((l) => l.trim()).filter(Boolean);
  const options: IssuesOptions = {
    repo: args.values.get('--repo')?.[0],
    apply: args.flags.has('--apply'),
    create: args.flags.has('--create'),
    close: args.flags.has('--close'),
    labels,
    json: args.flags.has('--json'),
    today: args.values.get('--today')?.[0],
  };
  const io = { gh, out: (text: string) => process.stdout.write(text), err: (text: string) => console.error(text) };
  return runIssues(targets.length ? targets : ['.'], options, io);
}

function reportDiffs(diffs: FileDiff[], checked: number, base: { since?: string; oldFile?: string }, flags: DiffFlags): number {
  const context = base.since ? `since ${base.since}` : `compared with ${base.oldFile}`;
  if (flags.json) {
    const rows = diffs.map((d) => ({ file: d.file, status: d.status, ...base, frontMatter: d.result.frontMatter, sections: d.result.sections, tokens: d.result.tokens }));
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  } else if (diffs.length) {
    process.stdout.write(diffs.map((d) => `${d.file}: ${d.status} ${context}\n\n${d.result.text}`).join('\n'));
  }
  const tokens = diffs.reduce((n, d) => n + d.result.tokens, 0);
  const full = diffs.filter((d) => d.status !== 'deleted').reduce((n, d) => n + d.result.fullTokens, 0);
  const saved = tokens < full ? `, ${Math.round((1 - tokens / full) * 100)}% smaller` : '';
  console.error(`[smd] ${diffs.length} of ${checked} file(s) changed ${context}: ≈${tokens} tokens (full agent view ≈${full}${saved})`);
  return flags.exitCode && diffs.length ? 1 : 0;
}

function installSkills(dir: string, only?: string): number {
  const chosen = SKILLS.filter((sk) => !only || sk.name.endsWith(only));
  if (!chosen.length) return fail('--only must be "reader" or "writer".');
  for (const skill of chosen) {
    const target = path.resolve(dir, skill.name);
    for (const [rel, content] of Object.entries(skill.files)) {
      fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
      fs.writeFileSync(path.join(target, rel), content);
    }
    // Bundle this very CLI (one self-contained file) so the skill works without npm.
    fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
    fs.copyFileSync(__filename, path.join(target, 'scripts', 'smd.cjs'));
    console.log(`Installed ${skill.name.padEnd(24)} → ${target}  (${skill.summary})`);
    removeLegacySkill(path.resolve(dir, legacySkillName(skill.name)));
  }
  return 0;
}

/** `semantic-markdown-reader` → `styled-markdown-reader`, the skill's name before 3.0. */
function legacySkillName(name: string): string {
  return name.replace(/^semantic-markdown-/, 'styled-markdown-');
}

/** A skill installed before 3.0 would load next to its renamed copy: remove it while it is still the one smd installed. */
function removeLegacySkill(folder: string): void {
  const skillFile = path.join(folder, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return;
  const name = /^name:\s*(\S+)/m.exec(fs.readFileSync(skillFile, 'utf8'))?.[1];
  if (name !== path.basename(folder)) {
    console.log(`Kept ${folder}: its SKILL.md isn't the one smd installed. Delete it if it is the old Styled Markdown skill.`);
    return;
  }
  fs.rmSync(folder, { recursive: true, force: true });
  console.log(`Removed ${folder}  (the same skill under its pre-3.0 name)`);
}

void Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
