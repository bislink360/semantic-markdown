import { DocumentGraph, followEdges, mandatoryClosure, type GraphDocument, type GraphNode } from '../../../src/core/graph';
import { traceRequirements } from '../../../src/core/trace';
import { defineScenario, type InProcessCase } from '../runner';

/**
 * Walking the document graph (t-17, CL-11) over a generated set of linked documents: deriving every edge, asking each
 * block what points at it and which rules apply to it, following edges three hops, the closure a section read needs,
 * and the requirement trace. Each run builds a new graph, as a request does, so cold and cached differ only in the
 * parse cache. `count` documents hold `blocks` requirements each.
 */

export function graphDocuments(count: number, blocks: number): GraphDocument[] {
  const docs: GraphDocument[] = [];
  for (let d = 0; d < count; d++) {
    const out = ['---', 'smd: 2', `title: Document ${d}`, '---', '', `## Rules ${d}`, ''];
    out.push(`:::constraint{#C${d} applies-to=S${d}} Every part of document ${d} logs its changes`, ':::', '', `## Section ${d} {#S${d}}`, '');
    for (let b = 0; b < blocks; b++) {
      const next = b + 1 < blocks ? `D${d}R${b + 1}` : `doc-${(d + 1) % count}.smd#D${(d + 1) % count}R0`;
      out.push(`:::requirement{#D${d}R${b} depends-on=${next}} Requirement ${b} of document ${d}`, `See :ref[D${d}R${(b + 3) % blocks}] and [the rules](#S${d}).`, ':::', '');
      out.push(`:::acceptance{#D${d}A${b} verifies=D${d}R${b}} Requirement ${b} is checked`, ':::', '');
      if (b % 5 === 0) out.push(`:::constraint{#D${d}C${b} applies-to=D${d}R${b}} Requirement ${b} is reviewed`, ':::', '');
    }
    docs.push({ path: `doc-${d}.smd`, text: out.join('\n') });
  }
  return docs;
}

interface State { docs: GraphDocument[] }

const blockNodes = (graph: DocumentGraph, docs: readonly GraphDocument[]): GraphNode[] => docs.flatMap((d) => {
  const lines = d.text.split('\n');
  return lines.flatMap((l, i) => (l.startsWith(':::requirement') ? [graph.nodeAt(d.path, i)!] : []));
});

const walk = (name: string, count: number, blocks: number, run: (graph: DocumentGraph, nodes: GraphNode[], docs: GraphDocument[]) => unknown): InProcessCase<State> => ({
  name: `${name}, ${count} documents of ${blocks} requirements`,
  setup: () => ({ docs: graphDocuments(count, blocks) }),
  run: (s) => {
    const graph = new DocumentGraph(s.docs, { today: '2026-11-01' });
    return run(graph, blockNodes(graph, s.docs), s.docs);
  },
  modes: ['cold', 'cached'],
});

export default defineScenario({
  name: 'graph-traversal',
  description: 'Deriving edges, incoming edges, the rules that apply, following edges, the mandatory closure and the requirement trace over linked documents.',
  tasks: ['t-17'],
  cases: [
    walk('derive every edge', 20, 40, (g) => g.allEdges()),
    walk('incoming edges of every requirement', 20, 40, (g, nodes) => nodes.map((n) => g.incoming(n))),
    walk('rules that apply to every requirement', 20, 40, (g, nodes) => nodes.map((n) => g.appliesTo(n))),
    walk('follow edges three hops from 20 requirements', 20, 40, (g, nodes) => followEdges(g, nodes.slice(0, 20), { types: ['depends-on', 'verifies', 'ref'], direction: 'both', depth: 3 })),
    walk('mandatory closure of 20 requirements', 20, 40, (g, nodes) => nodes.slice(0, 20).map((n) => mandatoryClosure(g, [n]))),
    {
      name: 'requirement trace, 20 documents of 40 requirements',
      setup: () => ({ docs: graphDocuments(20, 40) }),
      run: (s: State) => traceRequirements(s.docs, { today: '2026-11-01' }),
      modes: ['cold', 'cached'],
    },
  ],
});
