import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFullOldExtension, OLD_EXTENSION_ID } from '../src/oldExtension';

test('the old Styled Markdown extension: 2.x is the full one, the 3.x stub and junk are not', () => {
  assert.equal(OLD_EXTENSION_ID, 'bislink360.styled-markdown');
  for (const version of ['2.6.0', '1.0.0', '0.9.1']) assert.equal(isFullOldExtension(version), true, version);
  for (const version of ['3.0.0', '3.1.2', '10.0.0', '', 'x', undefined, 2]) assert.equal(isFullOldExtension(version), false, String(version));
});
