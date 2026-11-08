import {
  agentView, estimateTokens, outline, outlineProvenance, type AgentViewOptions, type AgentViewResult, type Provenance, type ResolvedSection,
} from './core';

/**
 * `smd read` and the MCP `read` tool: one call that gives an agent what it should read first. A document whose agent
 * view fits the budget comes back whole; a longer one comes back as its outline (sections with line ranges and token
 * costs), so the agent asks for the sections it needs next.
 */

/** Tokens below which the whole agent view is returned (the reader skill's "≲ 2,000 tokens: read it once"). */
export const READ_BUDGET = 2000;

export const READ_MODES = ['auto', 'outline', 'full'] as const;
export type ReadMode = (typeof READ_MODES)[number];

export interface ReadOptions
  extends Pick<AgentViewOptions, 'readFile' | 'today' | 'tokenizer' | 'file' | 'lineRefs' | 'exactSections' | 'constraints' | 'provenance'> {
  /** auto (default): whole view within the budget, else the outline. */
  mode?: ReadMode;
  /**
   * The threshold for `auto`, in tokens (default {@link READ_BUDGET}): the whole view at or under it, else the outline.
   * It does not cap what `full`, `outline` or `sections` return. Counted with `tokenizer` when one is given.
   */
  maxTokens?: number;
  brief?: boolean;
  /** Only these sections (heading text or id); overrides the mode. */
  sections?: string[];
}

export interface ReadResult {
  /** What was returned. */
  shown: 'full' | 'outline' | 'sections';
  text: string;
  /** Estimated tokens of the whole agent view, and of the file. */
  fullTokens: number;
  fileTokens: number;
  missingSections: string[];
  /** What `auto` compared with `maxTokens`: the tokenizer's name, or `estimate` (≈ characters / 4). */
  tokenBasis: string;
  /** The same sizes counted with the tokenizer, when one is given. */
  counted?: AgentViewResult['counted'];
  /** With `sections`: the headings each query selected. */
  resolvedSections?: ResolvedSection[];
  /** With `constraints` and `sections`: the constraints outside the sections (see agentView). */
  constraints?: AgentViewResult['constraints'];
  /** For a document with constraints or dependencies: what the view carries and could not satisfy (see agentView). */
  mandatory?: AgentViewResult['mandatory'];
  /** With `provenance`: the manifest of what was returned (the outline's when the outline is shown). */
  provenance?: Provenance;
}

export function readDocument(text: string, options: ReadOptions = {}): ReadResult {
  const { mode = 'auto', maxTokens = READ_BUDGET, brief, sections, exactSections, constraints, ...view } = options;
  const tokenBasis = view.tokenizer?.name ?? 'estimate';
  if (sections?.length) {
    const result = agentView(text, { ...view, brief, sections, exactSections, constraints });
    return {
      shown: 'sections', text: result.text, fullTokens: result.tokens, fileTokens: result.originalTokens, missingSections: result.missingSections,
      tokenBasis, ...counted(result), resolvedSections: result.resolvedSections,
      ...(result.constraints ? { constraints: result.constraints } : {}), ...(result.provenance ? { provenance: result.provenance } : {}),
      ...(result.mandatory ? { mandatory: result.mandatory } : {}),
    };
  }
  const full = agentView(text, { ...view, brief });
  const sizes = { fullTokens: full.tokens, fileTokens: full.originalTokens, missingSections: [], tokenBasis, ...counted(full) };
  // Route on the tokenizer's count when there is one, so an exact budget means exact routing.
  const size = full.counted?.tokens ?? full.tokens;
  if (mode === 'full' || (mode === 'auto' && size <= maxTokens)) {
    return {
      shown: 'full', text: full.text, ...sizes, ...(full.provenance ? { provenance: full.provenance } : {}), ...(full.mandatory ? { mandatory: full.mandatory } : {}),
    };
  }
  const unit = full.counted ? `${full.counted.tokenizer} tokens` : 'tokens';
  const approx = full.counted ? '' : '≈';
  const why = mode === 'auto' ? `The agent view (${approx}${size} ${unit}) is over the ${maxTokens}-token budget, so this is the outline. ` : '';
  const next = `${why}Read only the sections you need next.\n`;
  const outlineText = `${outline(text, { ...view, provenance: false }).trimEnd()}\n\n${next}`;
  const provenance = full.provenance && outlineProvenance(full.provenance, outlineText, view.tokenizer?.count(outlineText) ?? estimateTokens(outlineText));
  return { shown: 'outline', text: outlineText, ...sizes, ...(provenance ? { provenance } : {}) };
}

const counted = (result: AgentViewResult) => (result.counted ? { counted: result.counted } : {});
