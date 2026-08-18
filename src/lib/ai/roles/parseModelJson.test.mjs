import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson } from './parseModelJson.ts';

test('uses the final complete JSON object when a model emits an earlier JSON draft', () => {
  const text = '{"cmd":"draft"}\nHere is the final answer:\n{"questionType":"news","countries":["GY"]}';
  assert.deepEqual(parseModelJson(text), { questionType: 'news', countries: ['GY'] });
});

test('does not mistake braces inside a JSON string for object boundaries', () => {
  const text = 'Preamble {not JSON}\n{"headline":"The {braces} are text","claims":[],"gaps":[]}';
  assert.deepEqual(parseModelJson(text), { headline: 'The {braces} are text', claims: [], gaps: [] });
});

test('returns null for an unterminated JSON object', () => {
  assert.equal(parseModelJson('{"headline":"cut off"'), null);
});
