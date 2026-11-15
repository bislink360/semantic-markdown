import { agentView } from '../../../src/core';
import { defineScenario, type InProcessCase } from '../runner';

/**
 * A section read that carries a rule chain (t-58): rule Ci applies to Ri and depends on R(i+1), so each applicability
 * round adds one rule and one dependency, and each round looks at every rule again. The cost grows with the square of
 * the chain until the 50-block closure limit stops it, which the case past the limit shows. bench.ts keeps a ceiling
 * on the 49-round chain; this scenario records how the cost grows.
 */

export function ruleChain(n: number): string {
  const out = ['---', 'smd: 2', '---', '', '## Work', '', ':::requirement{#R0} Start', 'R0 text.', ':::', '', '## Rules', ''];
  for (let i = 0; i < n; i++) out.push(`:::constraint{#C${i} applies-to=R${i} depends-on=R${i + 1}} Rule ${i}`, `Rule ${i} text.`, ':::', '');
  out.push('## Store', '');
  for (let i = 1; i <= n; i++) out.push(`:::requirement{#R${i}} Item ${i}`, `Item ${i} text.`, ':::', '');
  return out.join('\n');
}

const chain = (n: number, label: string): InProcessCase<string> => ({
  name: label,
  setup: () => ruleChain(n),
  run: (text) => agentView(text, { sections: ['Work'], today: '2026-11-01' }),
  modes: ['cold', 'cached'],
});

export default defineScenario({
  name: 'rule-chain',
  description: 'A section read carrying a rule chain of 10, 25 and 49 rounds, and one past the 50-block limit.',
  tasks: ['t-17', 't-58'],
  cases: [chain(10, '10 rounds'), chain(25, '25 rounds'), chain(49, '49 rounds'), chain(60, '60 rules, past the limit')],
});
