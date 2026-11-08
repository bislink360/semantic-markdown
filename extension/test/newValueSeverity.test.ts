// A valid document stays valid in a minor release: invalid values on the attributes added in 4.1 are warnings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSmd } from '../src/core/validate';
import { NEW_VALUE_KEYS } from '../src/core/spec';

const v2 = (body: string) => `---\nsmd: 2\ntitle: T\n---\n\n${body}\n`;
const values = (text: string) => validateSmd(text).filter((d) => d.code === 'attrs/value').map((d) => d.severity);

test('4.0.0 read status on a question and basis on a progress bar as unknown attributes, so a bad value now warns', () => {
  assert.deepEqual(values(v2(':::question{status=pending} Q\nx\n:::')), ['warning']);
  assert.deepEqual(values(v2('A :progress{value=5 basis=guess}')), ['warning']);
  assert.deepEqual(values(v2(':::requirement{#R1 status=done priority=urgent} R\n:::')), ['warning', 'warning']);
  assert.deepEqual(values(v2(':::comment{for=x kind=praise} C\n:::')), ['warning']);
});

test('values that were already checked before 4.1 stay errors', () => {
  assert.deepEqual(values(v2(':::risk{impact=huge} R\nx\n:::')), ['error']);
  assert.deepEqual(values(v2(':::decision{status=maybe} D\nx\n:::')), ['error']);
  assert.deepEqual(values(v2('A :metric[1]{trend=sideways}')), ['error']);
});

test('the table names only enumerated attributes that exist', async () => {
  const { CONTAINERS, INLINE_DIRECTIVES } = await import('../src/core/spec');
  for (const [block, keys] of Object.entries(NEW_VALUE_KEYS)) {
    const spec = block.startsWith(':::') ? CONTAINERS[block.slice(3)] : INLINE_DIRECTIVES[block.slice(1)];
    assert.ok(spec, block);
    for (const key of keys) assert.ok(spec.values?.[key], `${block} ${key}`);
  }
});
