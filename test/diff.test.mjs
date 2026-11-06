import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiffFiles, formatDiff, sideBySideRows } from '../diff-view.mjs';

function plan(before, next, privatePaths = []) {
  return { direction: 'push', before: new Map(Object.entries(before).map(([p,v]) => [p, Buffer.from(v)])), target: new Map(Object.entries(next).map(([p,v]) => [p, Buffer.from(v)])), changes: [...new Set([...Object.keys(before), ...Object.keys(next)])], privatePaths };
}

test('theme change is one removed value and one added value, never a tilde status', () => {
  const p = plan({ 'settings.json': '{"theme":"crimson-noir"}' }, { 'settings.json': '{"theme":"system"}' });
  const files = buildDiffFiles(p), text = formatDiff(p, files);
  assert.match(text, /-\s+"theme": "crimson-noir"/);
  assert.match(text, /\+\s+"theme": "system"/);
  assert.doesNotMatch(text, /^~/m);
  assert.match(text, /^GitHub → versione da inviare/);
  assert.equal(files[0].rows.filter(r => r.kind === 'add').length, 1);
  assert.equal(files[0].rows.filter(r => r.kind === 'del').length, 1);
});

test('comparison uses remote contents, not unrelated local base contents', () => {
  const p = plan({ 'settings.json': '{"theme":"github"}' }, { 'settings.json': '{"theme":"outgoing"}' });
  p.base = new Map([['settings.json', Buffer.from('{"theme":"unrelated"}')]]);
  p.work = new Map([['settings.json', Buffer.from('{"theme":"local-overlay"}')]]);
  const text = formatDiff(p);
  assert.match(text, /github/); assert.match(text, /outgoing/);
  assert.doesNotMatch(text, /unrelated|local-overlay/);
});

test('added and removed files use only plus and minus', () => {
  const p = plan({ 'old.json': '{"old":1}' }, { 'new.json': '{"new":2}' });
  const text = formatDiff(p);
  assert.match(text, /- old.json/); assert.match(text, /\+ new.json/);
  assert.match(text, /-\s+"old": 1/); assert.match(text, /\+\s+"new": 2/);
});

test('private file removal never exposes its contents', () => {
  const p = plan({ 'settings.local.json': '{"data":"VERY_PRIVATE"}', 'custom.json': '{"data":"ALSO_PRIVATE"}' }, {}, ['settings.local.json', 'custom.json']);
  const text = formatDiff(p);
  assert.doesNotMatch(text, /VERY_PRIVATE|ALSO_PRIVATE/);
  assert.match(text, /file privato/);
});

test('sensitive JSON fields and URLs stay masked, even in the old remote version', () => {
  const p = plan({ 'mcp.json': JSON.stringify({ Authorization: 'OLD_SECRET', url: 'https://user:password@server/path?token=secret', note: 'old' }) }, { 'mcp.json': JSON.stringify({ note: 'new' }) });
  const text = formatDiff(p);
  assert.doesNotMatch(text, /OLD_SECRET|user:password|token=secret/);
  assert.match(text, /nascosto/);
});

test('equal masked content still shows a removal and an addition', () => {
  const p = plan({ 'data.json': '{"apiKey":"old"}' }, { 'data.json': '{"apiKey":"new"}' });
  const rows = buildDiffFiles(p)[0].rows;
  assert.deepEqual(rows.map(r => r.kind), ['del', 'add']);
  assert.ok(rows.every(r => !r.text.includes('"old"') && !r.text.includes('"new"')));
});

test('old and new rows align side by side without duplicating additions', () => {
  const rows = [{kind:'del',text:'a',oldLine:1}, {kind:'del',text:'b',oldLine:2}, {kind:'add',text:'c',newLine:1}, {kind:'context',text:'d',oldLine:3,newLine:2}];
  const pairs = sideBySideRows(rows);
  assert.equal(pairs.length, 3);
  assert.equal(pairs[0].old.text, 'a'); assert.equal(pairs[0].next.text, 'c');
  assert.equal(pairs[1].old.text, 'b'); assert.equal(pairs[1].next, undefined);
  assert.equal(pairs[2].old.text, 'd'); assert.equal(pairs[2].next.text, 'd');
});
