import { isSpan } from './corpus';
import type { AnswerObject, AnswerRecord, Span, Task } from './types';

/**
 * What the model runner says to the model, and how it reads the answer back. The system prompt is one fixed text for
 * every condition and task, as the protocol asks; the task, the answer format and (for whole-text conditions) the
 * document go in the user message.
 */

export const SYSTEM_PROMPT = [
  'You answer one question about one project document. Use only what the document says.',
  'The user message either contains the whole document or names its file for you to read with the read tool. When the document is in the message, the tool has nothing more to give.',
  'Line numbers are the 1-based lines of the document file. L12 and [L12] markers in what you read give them.',
  'Finish with only one JSON object in the format the user message asks for, and no other text.',
].join('\n');

/** The answer format for each task type, in the shape the scorer reads (see README "Scoring"). */
export const ANSWER_FORMATS: Record<Task['type'], string> = {
  'fact-lookup': 'Answer with {"text": "<the answer, as short as possible>", "lines": [[start, end]]}, where lines are the line spans you took it from.',
  'constraint-check': 'Answer with {"verdict": "yes" or "no", "lines": [[start, end]]}, where lines are the span of the rule that decides it.',
  'decision-status': 'Answer with {"option": "<the option to implement, named as the document names it>", "lines": [[start, end]]}, where lines are the span of the decision.',
  'open-question': 'Answer with {"undecided": true or false, "fallback": "<what to do until it is decided, or an empty string>", "lines": [[start, end]]}.',
  qualification: 'Answer with {"text": "<your answer>"}.',
  'edit-plan': 'Answer with {"lines": [[start, end], ...]}, listing every line that must change and no other line.',
};

/** The user message of a condition that shows the whole text. */
export function wholeTextMessage(file: string, text: string, task: Task): string {
  return [
    `The document is the file ${file}. Here it is in full, between <document> and </document>.`, '',
    '<document>', text.replace(/\n$/, ''), '</document>', '',
    `Task: ${task.prompt}`, '', ANSWER_FORMATS[task.type],
  ].join('\n');
}

/** The user message of a condition where the model reads with the tool. */
export function toolMessage(file: string, task: Task): string {
  return [`The document is the file ${file}. Read it with the read tool.`, '', `Task: ${task.prompt}`, '', ANSWER_FORMATS[task.type]].join('\n');
}

/** Every top-level JSON object in a text (outside strings), in order; fenced blocks are read as text too. */
function jsonObjects(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"' && depth > 0) inString = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) {
      try {
        const v = JSON.parse(text.slice(start, i + 1));
        if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
      } catch { /* not JSON: prose with braces */ }
    }
  }
  return out;
}

/** The answer object in a model's final text: the last JSON object in it (fenced or bare), or undefined. */
export function extractJson(text: string): Record<string, unknown> | undefined {
  const fenced = [...text.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)].flatMap((m) => jsonObjects(m[1]));
  const found = fenced.length ? fenced : jsonObjects(text);
  if (found.length) return found[found.length - 1];
  // A stray brace in the prose before it unbalances the scan: try each opening brace up to the last closing one.
  const end = text.lastIndexOf('}');
  for (let i = text.lastIndexOf('{', end); i >= 0; i = i > 0 ? text.lastIndexOf('{', i - 1) : -1) {
    try {
      const v = JSON.parse(text.slice(i, end + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* keep looking */ }
  }
  return undefined;
}

const asString = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);

function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  return undefined;
}

/** Line spans from what a model wrote: `[[a, b], …]`, one `[a, b]`, or single line numbers. */
export function asSpans(v: unknown): Span[] | undefined {
  if (isSpan(v)) return [v];
  if (!Array.isArray(v)) return undefined;
  const spans = v.flatMap((s): Span[] => (isSpan(s) ? [s] : Number.isInteger(s) && (s as number) >= 1 ? [[s as number, s as number]] : []));
  return spans;
}

/** The part of an answer record that comes from the model's final text. */
export type ParsedAnswer = Pick<AnswerRecord, 'answer' | 'lines' | 'cited' | 'error'>;

/**
 * Reads a final answer: the JSON object's known fields (`text` or `answer`, `verdict`, `option`, `undecided`,
 * `fallback`, `lines`, `cited`). Without a JSON object the raw text is the answer and `error` is `parse`, so it is
 * still recorded and scored (as text) rather than lost.
 */
export function parseAnswer(text: string): ParsedAnswer {
  if (!text.trim()) return { answer: '', error: 'empty' };
  const obj = extractJson(text);
  if (!obj) return { answer: text, error: 'parse' };
  const answer: AnswerObject = {};
  const t = asString(obj.text) ?? asString(obj.answer);
  if (t !== undefined) answer.text = t;
  const verdict = asString(obj.verdict);
  if (verdict !== undefined) answer.verdict = verdict;
  const option = asString(obj.option);
  if (option !== undefined) answer.option = option;
  const undecided = asBoolean(obj.undecided);
  if (undecided !== undefined) answer.undecided = undecided;
  const fallback = asString(obj.fallback);
  if (fallback !== undefined) answer.fallback = fallback;
  const out: ParsedAnswer = { answer };
  const lines = asSpans(obj.lines);
  if (lines?.length) out.lines = lines;
  if (Array.isArray(obj.cited)) out.cited = obj.cited.filter((c): c is string => typeof c === 'string');
  return out;
}
