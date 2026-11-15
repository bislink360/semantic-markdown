import { agentView, estimateTokens } from '../../../src/core';
import { defineScenario, type InProcessCase } from '../runner';

/**
 * Budgeted reads of a document with many protected blocks: sections that each hold a danger, a rule or an agent
 * block among ordinary text, so a budget must keep those while it omits the rest. It forces many omission decisions,
 * as the research contract's overflow rules ask a budget to make.
 */

export function protectedDocument(sections: number): string {
  const out = ['---', 'smd: 2', 'title: Many protected blocks', '---', ''];
  for (let i = 0; i < sections; i++) {
    out.push(`## Section ${i}`, '', `${'Ordinary text about this part of the system. '.repeat(8)}`, '');
    if (i % 3 === 0) out.push(':::danger', `Never skip step ${i}.`, ':::', '');
    if (i % 3 === 1) out.push(`:::constraint{#C${i}} Part ${i} keeps an audit log`, ':::', '');
    if (i % 5 === 0) out.push(':::agent', `Check part ${i} before editing it.`, ':::', '');
    out.push(`- [ ] Task ${i}`, '', `${'More detail that a budget may leave out. '.repeat(6)}`, '');
  }
  return out.join('\n');
}

const budget = (sections: number, share: number): InProcessCase<{ text: string; max: number }> => ({
  name: `${sections} sections, budget ${Math.round(share * 100)}% of the view`,
  setup: () => {
    const text = protectedDocument(sections);
    return { text, max: Math.round(estimateTokens(agentView(text, { today: '2026-11-01' }).text) * share) };
  },
  run: (s) => agentView(s.text, { maxTokens: s.max, today: '2026-11-01' }),
  modes: ['cold', 'cached'],
});

export default defineScenario({
  name: 'protected-budget',
  description: 'Budgeted agent views of documents with many danger, rule and agent blocks, which force many omissions.',
  tasks: ['t-27'],
  cases: [budget(60, 0.5), budget(60, 0.2), budget(200, 0.2)],
});
