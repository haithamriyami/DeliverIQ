import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAutoSortFlag } from '../src/controllers/recipientsController.js';

test('autoSort defaults to on when the field is missing (stale JS / multipart omission)', () => {
  assert.equal(parseAutoSortFlag(undefined), true);
  assert.equal(parseAutoSortFlag(null), true);
  assert.equal(parseAutoSortFlag(''), true);
});

test('autoSort accepts multipart strings and JSON booleans', () => {
  assert.equal(parseAutoSortFlag('true'), true);
  assert.equal(parseAutoSortFlag('TRUE'), true);
  assert.equal(parseAutoSortFlag('1'), true);
  assert.equal(parseAutoSortFlag('on'), true);
  assert.equal(parseAutoSortFlag(true), true);
  assert.equal(parseAutoSortFlag('false'), false);
  assert.equal(parseAutoSortFlag('0'), false);
  assert.equal(parseAutoSortFlag('off'), false);
  assert.equal(parseAutoSortFlag(false), false);
});
